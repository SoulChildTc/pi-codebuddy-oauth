// src/index.ts — Pi 扩展入口：注册 codebuddy provider（HTTP 直连 /v2/chat/completions）
//
// 数据流：
//   Pi agent → modelRuntime.streamSimple（auth 解析 + before_provider_headers 合并）
//     → 本插件 streamSimple wrapper（注入 22 头 + 自定义 fetch）
//     → auth-fetch 拦截器（认证头注入 + 401/403 刷新重试 + 11133 瞬时 400 退避）
//     → ${server}/v2/chat/completions
//
// 与 opencode 版的对应关系：
//   opencode auth.loader.fetch  → SimpleStreamOptions.fetch（auth-fetch 拦截器）
//   opencode chat.headers       → wrapper 内 options.headers（provider 边界清晰，事件无 provider 信息）
//   opencode config（模型发现） → registerProvider.models + 登录/启动后主动发现重注册
//   opencode auth.methods       → registerProvider.oauth.login / refreshToken（Pi 原生 /login）
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getConfig, resolveServerUrl, PROVIDER_ID, CHAT_COMPLETIONS_PATH, POLL_TOTAL_TIMEOUT_MS, DEFAULT_EXPIRES_MS } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { effectiveAuth, pickAuthMode } from "./auth-state.js";
import type { AuthState } from "./auth-state.js";
import { requestAuthState, pollForToken, refreshAccessToken } from "./auth-flow.js";
import { createAuthFetch } from "./auth-fetch.js";
import { createCodebuddyStreamSimple } from "./stream.js";
import { buildRequestHeaders, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { fetchRemoteConfig, remoteModelToPi, DEFAULT_MODEL, DiscoveryCache, type RemoteConfig } from "./models.js";
import { priceStatusForModel, type RemotePromotion } from "./pricing.js";
import { readCachedConfig, writeCachedConfig } from "./model-cache.js";
import * as fs from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export default async function codebuddyExtension(pi: ExtensionAPI) {
  const cfg = getConfig();
  const server = resolveServerUrl(cfg);
  const logger = createLogger();
  const conversationIds = new LRUMap<string, string>(cfg.conversationMapMax);
  const discoveryCache = new DiscoveryCache({
    ttlMs: 5 * 60 * 1000,
    fetchFn: (token, signal) => fetchRemoteConfig(token, server, signal),
  });

  // --- token 快照（~/.pi/agent/codebuddy-auth.json）---
  // Pi CredentialStore 不对扩展暴露读取接口；login/refresh 全部经过本扩展，
  // 顺手落一份独立快照供请求时读取。真实凭据源仍是 Pi auth.json（由 Pi 自动持久化）。
  const snapshotPath = join(homedir(), CONFIG_DIR_NAME || ".pi", "agent", "codebuddy-auth.json");
  const syncSnapshot: { value: OAuthCredentials | undefined } = { value: undefined };

  async function loadSnapshot(): Promise<void> {
    try {
      const raw = await fs.readFile(snapshotPath, "utf8");
      const o = JSON.parse(raw) as Partial<OAuthCredentials>;
      if (typeof o.access === "string" && o.access) {
        syncSnapshot.value = { access: o.access, refresh: o.refresh ?? "", expires: o.expires ?? 0 };
      }
    } catch { /* 不存在或损坏 → 未登录 */ }
  }
  await loadSnapshot();

  async function persistSnapshot(cred: OAuthCredentials): Promise<void> {
    syncSnapshot.value = cred;
    try {
      await fs.mkdir(dirname(snapshotPath), { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify(cred, null, 2), "utf8");
    } catch (e) {
      logger.error(`snapshot write failed: ${(e as Error).message}`);
    }
  }

  function credToAuthState(cred: OAuthCredentials | undefined): AuthState | undefined {
    if (!cred) return undefined;
    return { type: "oauth", access: cred.access, refresh: cred.refresh ?? "", expires: cred.expires ?? 0 };
  }

  // --- 刷新（auth-fetch 401 兜底用）：单飞 + 写快照 ---
  // Pi 原生 refreshToken 仅在 resolveStoredOAuth 过期路径触发；流中途 401 由这里兜底
  class RefreshLock {
    private inflight: Promise<AuthState | null> | null = null;
    run(fn: () => Promise<AuthState | null>): Promise<AuthState | null> {
      if (this.inflight) return this.inflight;
      this.inflight = fn().finally(() => { this.inflight = null; });
      return this.inflight;
    }
  }
  const refreshLock = new RefreshLock();

  async function refreshAndPersist(oauthAuth: AuthState & { type: "oauth" }): Promise<AuthState | null> {
    return refreshLock.run(async () => {
      const r = await refreshAccessToken(oauthAuth.refresh, server.url);
      if (r?.accessToken) {
        const cred: OAuthCredentials = {
          access: r.accessToken,
          refresh: r.refreshToken || oauthAuth.refresh,
          expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
        };
        await persistSnapshot(cred);
        return credToAuthState(cred)!;
      }
      logger.warn("token refresh failed — token may be expired, re-run /login codebuddy");
      return null;
    });
  }

  // --- auth-fetch 拦截器 + streamSimple wrapper ---
  const authFetch = createAuthFetch({
    getAuth: async () => effectiveAuth(credToAuthState(syncSnapshot.value), cfg),
    server,
    buildAuthHeaders,
    resolveIdentity: resolveIdentity as any,
    decodeJwtPayload,
    refreshAndPersist,
    cfg,
    logger,
    chatCompletionsPath: CHAT_COMPLETIONS_PATH,
  });
  const streamSimple = createCodebuddyStreamSimple(authFetch, {
    buildHeaders: (model, options) =>
      buildRequestHeaders(options?.sessionId, model.id, { cfg, server, lru: conversationIds }),
  });

  // --- 模型列表 ---
  // 最近一次发现的促销与单价（供 footer 状态行按当前时段动态显示价格/折扣）
  let latestPromotions: RemotePromotion[] = [];
  // footer 定价状态的最后一个事件上下文（refreshPricingStatus 默认参数用；
  // 声明必须在 discoverAndReregister 首次调用前完成——工厂阶段会 await 发现）
  let lastCtx: ExtensionContext | undefined;
  const creditsById = new Map<string, string | undefined>();

  function modelsFromRemote(remote: RemoteConfig) {
    latestPromotions = remote.promotions;
    creditsById.clear();
    for (const m of remote.models) creditsById.set(m.id, m.credits);
    return remote.models.map((m) => remoteModelToPi(m, remote.promotions));
  }
  function fallbackModels() {
    return modelsFromRemote({ models: [DEFAULT_MODEL], promotions: [] });
  }
  // 启动种子：优先用上次落盘的模型列表，避免会话恢复时模型还没发现完（见 model-cache.ts）
  // 刻意不打日志：命中缓存是常规路径，每次启动都打印会污染 TUI/print 输出
  // v2 缓存存原始 RemoteModel，经 modelsFromRemote 重新映射——映射逻辑升级
  // （多模态/价格）自动作用于种子，不会无限期滞留旧生成的 PiModelConfig
  const cachedConfig = await readCachedConfig();
  let registeredModels = cachedConfig ? modelsFromRemote(cachedConfig) : fallbackModels();

  // 主动发现 + 重注册（registerProvider 可随时调用并立即生效）
  async function discoverAndReregister(token: string): Promise<void> {
    try {
      const remote = await discoveryCache.get(token, { signal: undefined });
      const models = modelsFromRemote(remote);
      if (!models.length) return;
      registeredModels = models;
      register(models);
      await writeCachedConfig(remote);
      refreshPricingStatus();
    } catch (e) {
      const status = (e as any)?.status;
      if (status === 401 || status === 403) {
        logger.warn("model discovery 401/403 — token may be expired, re-run /login codebuddy");
      } else {
        logger.warn(`model discovery failed: ${(e as Error).message}`);
      }
    }
  }

  function register(models: typeof registeredModels) {
    pi.registerProvider(PROVIDER_ID, {
      name: "CodeBuddy",
      baseUrl: `${server.url}/v2`,
      api: "openai-completions",
      // 认证统一由 auth-fetch 拦截器注入（oauth 双头身份 + api 双头 key）；
      // apiKey 仅作为 OpenAI client 的占位（拦截器会覆写 Authorization）
      apiKey: cfg.apiKey || "not-used",
      models: models as any,
      streamSimple,
      oauth: {
        name: "CodeBuddy (IOA)",
        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const state = await requestAuthState(server.url);
          callbacks.onAuth({ url: state.url, instructions: "请在浏览器中完成 IOA 登录" });
          const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS;
          const tok = await pollForToken(server.url, state.state, expiresAt, callbacks.signal);
          if (!tok?.accessToken) throw new Error("CodeBuddy IOA login failed or timed out");
          const cred: OAuthCredentials = {
            access: tok.accessToken,
            refresh: tok.refreshToken || "",
            expires: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
          await persistSnapshot(cred);
          // 登录后立即发现模型并重注册（Pi 的 credential-change refresh 走 allowNetwork:false，不触发网络发现）
          void discoverAndReregister(cred.access);
          return cred;
        },
        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          if (!credentials.refresh) throw new Error("codebuddy: no refresh token stored");
          const r = await refreshAccessToken(credentials.refresh, server.url);
          if (!r?.accessToken) throw new Error("codebuddy: token refresh failed — re-run /login codebuddy");
          const cred: OAuthCredentials = {
            access: r.accessToken,
            refresh: r.refreshToken || credentials.refresh,
            expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
          await persistSnapshot(cred);
          return cred;
        },
        getApiKey(credentials: OAuthCredentials): string {
          return credentials.access;
        },
      },
      refreshModels: async (context: RefreshModelsContext) => {
        // Pi 允许网络时按凭据发现；登录后的 credential-change 刷新 allowNetwork=false，走 fallback
        const cred = context.credential?.type === "oauth" ? context.credential : undefined;
        if (cred?.access && context.allowNetwork) {
          try {
            const remote = await discoveryCache.get(cred.access, { signal: context.signal });
            const models = modelsFromRemote(remote);
            if (models.length) {
              registeredModels = models;
              await writeCachedConfig(remote);
              return models as any;
            }
          } catch (e) {
            logger.warn(`model discovery failed: ${(e as Error).message}`);
          }
        }
        return registeredModels as any;
      },
    } as any);
  }

  register(registeredModels);

  // 启动时已有快照 token → 发现真实模型列表
  // 注意：必须 await。原先的 void（fire-and-forget）会让发现与进程退出赛跑，
  // --list-models 这类短命进程会在 /v3/config 返回前退出，缓存永远写不进。
  // 扩展 factory 阶段 pi 会等待，且 discoveryCache 有 5s 超时与 try/catch 兜底，不会卡住启动。
  const mode = pickAuthMode(cfg, credToAuthState(syncSnapshot.value));
  if (mode === "oauth" && syncSnapshot.value?.access) {
    await discoverAndReregister(syncSnapshot.value.access);
  } else if (mode === "api" && !cfg.apiKey) {
    logger.warn("api key mode requested but no key found — set CODEBUDDY_API_KEY");
  }

  // --- compaction 后淘汰 conversation-id（对应 opencode session.compacted）---
  pi.on("session_before_compact", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid) conversationIds.delete(sid);
  });

  // --- footer 状态行：当前模型的积分价格/生效折扣 ---
  // 模型选择器只能展示注册时算好的 name（价格按注册时的时段固定）；
  // 折扣按时段动态生效（如 glm-5.2 夜间 5 折），footer 这里在每次
  // model_select / turn_end 后按当前时间重算，保证时段切换后价格新鲜。
  function refreshPricingStatus(ctx: ExtensionContext | undefined = lastCtx): void {
    if (!ctx || ctx.mode !== "tui" || !ctx.ui) return;
    const model = ctx.model;
    if (!model || model.provider !== PROVIDER_ID) {
      ctx.ui.setStatus("codebuddy", undefined);
      return;
    }
    ctx.ui.setStatus("codebuddy", priceStatusForModel(model.id, creditsById.get(model.id), latestPromotions));
  }
  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    refreshPricingStatus(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    lastCtx = ctx;
    refreshPricingStatus(ctx);
  });
  pi.on("turn_end", () => {
    refreshPricingStatus();
  });
}
