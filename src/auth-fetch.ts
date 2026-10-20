// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/auth-fetch.ts — 平移自 opencode-codebuddy-oauth，改造为 Pi 版：
// 1. 删除 SSE 缓冲（pi-ai 原生解析 SSE，无 opencode UI 碎片化问题）
// 2. 删除预刷新（Pi resolveStoredOAuth 原生 5min skew 预刷新 + 双检锁）
// 3. 401/403 刷新经 refreshAndPersist 回调落地到 Pi CredentialStore（由 index.ts 接线）
// 4. 11133 瞬时 400 退避重发保留
import type { AuthState } from "./auth-state.js";
import type { CodeBuddyConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { TokenPair } from "./auth-flow.js";
import {
  createLeakState,
  isEventStreamResponse,
  rewriteLeakedReasoningStream,
  summarizeLeakRewrite,
} from "./reasoning-leak.js";

/**
 * 把限流头里的数值统一定位成“还需等待多少毫秒”。
 * 网关可能给相对秒（OpenAI）、相对毫秒（gRPC 风格）、秒/毫秒级 epoch，戒略不同。
 */
function normalizeDelayMs(num: number): number {
  if (num > 1e12) return Math.max(0, num - Date.now()); // 毫秒级 epoch
  if (num > 1e9) return Math.max(0, (num - Date.now() / 1000) * 1000); // 秒级 epoch
  return Math.max(0, num * 1000); // 相对秒（小于 1e9 秒 ≈ 31 年，当成相对量安全）
}

/** 读 Retry-After(-ms) / X-RateLimit-Reset* 提示，返回建议等待毫秒数。 */
export function parseRetryDelayMs(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const v = Number.parseFloat(ms);
    if (Number.isFinite(v)) {
      // `retry-after-ms` 按惯例是相对毫秒；只有像 epoch 的巨大值才减当前时间。
      return v > 1e12 ? Math.max(0, v - Date.now()) : Math.max(0, v);
    }
  }
  for (const name of ["retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    const num = Number.parseFloat(raw);
    if (Number.isFinite(num)) return normalizeDelayMs(num);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

/** 复制响应头并去掉实体会话字段：改写后的 SSE 长度/编码已变，留着会误导 SDK。 */
function headersWithoutEntity(headers: Headers): Headers {
  const h = new Headers(headers);
  h.delete("content-length");
  h.delete("content-encoding");
  h.delete("transfer-encoding");
  return h;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 合成可读的 429 错误 body。
 * 关键：终态（配额窗口很远）文案里带 "quota exceeded"，命中 Pi 的
 * NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN → 立即失败；否则保留 "429 / rate limit"
 * 字样，交给 Pi 的退避重试。
 */
export function buildRateLimitMessage(hintMs: number | undefined, terminal: boolean, gatewayBody: string): string {
  const hint = hintMs === undefined ? "无 Retry-After 提示" : `网关建议 ${Math.ceil(hintMs / 1000)}s 后重试`;
  const extra = gatewayBody ? ` | 网关 body: ${gatewayBody.slice(0, 200)}` : " | 网关未返回 body";
  if (terminal) {
    return `codebuddy: 上游配额超限（quota exceeded），${hint}，超出本地等待预算。等配额窗口过去或改用其他模型。${extra}`;
  }
  return `codebuddy: 网关限流 HTTP 429（rate limit / too many requests），${hint}。降低并发或稍后重试。${extra}`;
}

export type AuthFetchDeps = {
  getAuth: () => Promise<AuthState | null>;
  server: { url: string; domain: string };
  buildAuthHeaders: (auth: AuthState, identity: { tenantId:string; enterpriseId:string; userId:string }) => Record<string,string>;
  resolveIdentity: (payload: unknown, cfg: unknown) => { tenantId:string; enterpriseId:string; userId:string };
  decodeJwtPayload: (token:string) => unknown;
  refreshAndPersist: (oauthAuth: AuthState & { type:"oauth" }) => Promise<AuthState | null>;
  cfg: CodeBuddyConfig;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  chatCompletionsPath: string;
};

export function createAuthFetch(deps: AuthFetchDeps) {
  const { getAuth, server, buildAuthHeaders, resolveIdentity, decodeJwtPayload, refreshAndPersist, cfg, fetchImpl, chatCompletionsPath } = deps;
  const doFetch = () => fetchImpl ?? globalThis.fetch;
  let lastRefreshFailedAt = 0;
  const COOLDOWN_MS = 15_000;
  const inCooldown = () => Date.now() - lastRefreshFailedAt < COOLDOWN_MS;

  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    if (!urlStr.includes(chatCompletionsPath)) return doFetch()(url, init);
    const auth = await getAuth();
    if (!auth) {
      // 不抛异常：OpenAI SDK 会把 fetch 抛错包装成 "Connection error" 丢失信息；
      // 返回 401 Response 走 SDK 标准错误路径，message 保留我们的指引
      return new Response(JSON.stringify({ error: { message: "codebuddy: not authenticated — run `/login codebuddy` (oauth) or set CODEBUDDY_API_KEY" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (!init?.body) return new Response(JSON.stringify({ error: "Missing request body" }), { status: 400, headers: { "Content-Type": "application/json" } });

    const doRequest = async (a: AuthState) => {
      const headers = new Headers(init.headers as HeadersInit);
      const identity = a.type === "oauth" ? resolveIdentity(decodeJwtPayload(a.access), cfg) : { tenantId:"", enterpriseId:"", userId:"" };
      for (const [k,v] of Object.entries(buildAuthHeaders(a, identity))) headers.set(k, v);
      let body: BodyInit | null | undefined = init.body as BodyInit;
      // 仅处理字符串 JSON body；其他类型（Stream/FormData/Blob）跳过解析直接透传
      if (typeof body === "string") {
        try {
          const parsed = JSON.parse(body);
          if (parsed.stream === true && !parsed.stream_options) { parsed.stream_options = { include_usage: true }; body = JSON.stringify(parsed); }
        } catch {}
      }
      return doFetch()(`${server.url}${chatCompletionsPath}`, { method: "POST", headers, body: body as BodyInit, signal: init.signal });
    };

    let activeAuth: AuthState = auth;
    let response = await doRequest(activeAuth);
    if (activeAuth.type === "oauth" && (response.status === 401 || response.status === 403) && activeAuth.refresh && !inCooldown()) {
      const next = await refreshAndPersist(activeAuth);
      if (next) {
        activeAuth = next;
        response = await doRequest(activeAuth);
      }
    }
    // 瞬时 400（code 11133）重试：CodeBuddy 网关偶发把上游厂商的瞬时校验失败包装成 11133 返回
    // （服务端侧故障窗口，同构请求稍后重发即成功）。body 为字符串 JSON 可幂等重发；400 到达即流未开始。
    const TRANSIENT_400_RETRIES = 4;
    const RETRY_DELAYS_MS = [1000, 4000, 10000, 25000];
    for (let attempt = 0; response.status === 400 && attempt < TRANSIENT_400_RETRIES; attempt++) {
      const text = await response.text();
      let code: unknown;
      try { code = (JSON.parse(text) as any)?.code; } catch {}
      if (code !== 11133) {
        const h = new Headers(response.headers);
        h.set("Content-Type", "application/json");
        return new Response(text, { status: 400, headers: h });
      }
      if (init.signal?.aborted) break;
      deps.logger?.warn(`upstream transient 400 (11133), retry ${attempt + 1}/${TRANSIENT_400_RETRIES}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]));
      if (init.signal?.aborted) break;
      response = await doRequest(activeAuth);
    }
    // 429：CodeBuddy 网关限流时只返回状态码、body 为空（与 models.ts 里注释的
    // "400 status code (no body)" 同源），上层只能看到 "429 status code (no body)"；
    // 而 Pi 的 agent 级重试只看错误文案、不读 Retry-After，于是盲打 4 次。
    // 这里：① 有 Retry-After 且在预算内 → 就地幂等重发（body 为字符串 JSON）；
    //      ② 仍被拒 / 无提示 / 窗口很远 → 合成可读 body，并区分终态与可重试。
    if (response.status === 429) {
      let hintMs = parseRetryDelayMs(response.headers);
      let gatewayBody = await safeText(response);
      const retries = cfg.rateLimitRetries ?? 0;
      for (let attempt = 0; response.status === 429 && attempt < retries; attempt++) {
        if (init.signal?.aborted) break;
        if (hintMs === undefined || hintMs > cfg.rateLimitMaxWaitMs) break;
        deps.logger?.warn(`429 rate limited, waiting ${hintMs < 1000 ? hintMs + "ms" : Math.ceil(hintMs / 1000) + "s"} then retrying (${attempt + 1}/${retries})`);
        try {
          await abortableSleep(hintMs, init.signal);
        } catch {
          break;
        }
        response = await doRequest(activeAuth);
        if (response.status === 429) {
          hintMs = parseRetryDelayMs(response.headers);
          gatewayBody = await safeText(response);
        }
      }
      if (response.status === 429) {
        const terminal = hintMs === undefined ? false : hintMs > cfg.rateLimitMaxWaitMs;
        const h = headersWithoutEntity(response.headers);
        h.set("Content-Type", "application/json");
        return new Response(
          JSON.stringify({
            error: {
              message: buildRateLimitMessage(hintMs, terminal, gatewayBody),
              type: "rate_limit_error",
              code: terminal ? "quota_exceeded" : "rate_limited",
              status: 429,
            },
          }),
          { status: 429, headers: h },
        );
      }
    }
    if (!response.ok) {
      const text = await response.text();
      const h = new Headers(response.headers);
      h.set("Content-Type", "application/json");
      return new Response(text, { status: response.status, headers: h });
    }
    // 上游会把模型的思考草稿直接混进 delta.content，并留下 `</think:会话id>` 闭合标记；
    // pi-ai 只从 reasoning_content 建 thinking 块，于是整段自我复读被打印到终端、又被写回
    // transcript 强化下一轮。在 SSE 层把标记之前的文本改写到 reasoning_content。
    if (
      cfg.rewriteLeakedReasoning &&
      response.body &&
      isEventStreamResponse(response.headers.get("content-type"))
    ) {
      const state = createLeakState();
      const wrapped = rewriteLeakedReasoningStream(response.body, state, (s) =>
        summarizeLeakRewrite(s, deps.logger),
      );
      return new Response(wrapped as unknown as BodyInit, {
        status: response.status,
        statusText: response.statusText,
        headers: headersWithoutEntity(response.headers),
      });
    }
    return response;
  };
}
