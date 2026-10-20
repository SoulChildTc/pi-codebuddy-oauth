// src/reasoning-leak.ts — 上游"思考泄漏"归一化
//
// 现象（实测于 codebuddy/hy4-preview）：网关把模型的 reasoning 直接混进 SSE 的
// `choices[].delta.content` 里下发，并在思考段结束时留下一个带会话 id 的模板闭合标记
// `</think:6124c78e>`。pi-ai 只会把 `reasoning_content` / `reasoning` / `reasoning_text`
// 字段建成 thinking 块，于是整段自我复读的草稿被当成正文打印到终端，并被写回
// transcript 参与下一轮 prompt —— 复读在上下文里成了主导模式，越跑越严重。
//
// 本模块在 SSE 字节流层做归一化：把"闭合标记之前"的 content 改写到
// `delta.reasoning_content`，标记本身从流里删除。pi-ai 因此正常折叠成 thinking 块，
// 终端只看到标记之后的真实回答，写回 transcript 的历史也不再是复读垃圾。
//
// 规则（保守，宁可漏改不可错改）：
//   - `</think:hex>` / `</thinking:hex>` / `</thought:hex>` / `</reasoning:hex>`
//     → 边界：之前的文本判为 reasoning，之后的文本判为正文。
//   - 其余裸标记（`...` / `...` / `...`）→ 仅删除标记本身，不改变文本归属。
import type { Logger } from "./log.js";

/** 可能出现的思考分隔符（词干），用于整段匹配与"半个标记"预判。 */
const WORDS = ["think", "thinking", "thought", "reasoning"] as const;

/** 完整标记：`<` [`/`] [ws] word [ws] [`:` [ws] hex{4,32} [ws] `>` */
const MARKER_RE = new RegExp(
  `<\\/?\\s*(?:${WORDS.join("|")})\\s*(?::\\s*[0-9a-fA-F]{4,32}\\s*)?>`,
  "gi",
);

/** 带 id 的闭合标记 —— 唯一可以安全判定"前面是思考"的形态。 */
const CLOSE_WITH_ID_RE = new RegExp(
  `^</\\s*(?:${WORDS.join("|")})\\s*:\\s*[0-9a-fA-F]{4,32}\\s*>$`,
  "i",
);

/** 尾部最多预判多少个字符（覆盖 `</reasoning:` + 32 位 hex + 空白 + `>`）。 */
const MAX_PARTIAL_LEN = 1 + 1 + 9 + 1 + 1 + 32 + 1 + 1;

/** `t` 是否可能是某个完整标记的前缀（用于跨 chunk 拆分时的暂存判断）。 */
function isMarkerPrefix(t: string): boolean {
  const lt = t.toLowerCase();
  if (lt.length === 0 || !lt.startsWith("<")) return false;
  if (lt.length > MAX_PARTIAL_LEN) return false;
  const head = /^<(\/?)([a-z]*)/.exec(lt);
  if (!head) return false;
  const word = head[2];
  if (!WORDS.some((w) => w.startsWith(word))) return false;
  const rest = lt.slice(head[0].length);
  if (rest === "") return true;
  // 词干之后只允许：空白、`>`、或 `:` + hex + 可选空白 + 可选 `>`
  return /^\s*(?:>|:\s*[0-9a-f]*\s*>?$)/.test(rest);
}

/** 返回 `s` 末尾"可能是半个标记"的最长后缀（没有则空串）。 */
function partialMarkerTail(s: string): string {
  const max = Math.min(s.length, MAX_PARTIAL_LEN);
  for (let len = max; len >= 1; len--) {
    const cand = s.slice(s.length - len);
    if (cand.charCodeAt(0) !== 60 /* '<' */) continue;
    if (isMarkerPrefix(cand)) return cand;
  }
  return "";
}

/** 跨事件状态：`pending` 是因为可能是半个标记而暂扣的正文文本。 */
export interface LeakRewriteState {
  pending: string;
  eventsRewritten: number;
  charsToReasoning: number;
  markersRemoved: number;
}

export function createLeakState(): LeakRewriteState {
  return { pending: "", eventsRewritten: 0, charsToReasoning: 0, markersRemoved: 0 };
}

interface DeltaCarrier {
  delta?: { content?: unknown; reasoning_content?: unknown };
}

/**
 * 改写单条 `data:` 载荷（字符串）。返回 null 表示无需改写（原样透传）。
 * 纯函数便于单测：`state` 只用到 `pending` 与计数字段。
 */
export function rewriteDataPayload(payload: string, state: LeakRewriteState): string | null {
  if (payload === "[DONE]" || payload.length === 0) return null;
  if (payload.charCodeAt(0) !== 123 /* '{' */) return null;

  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  const choices = (body as { choices?: DeltaCarrier[] })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  let touched = false;
  for (const choice of choices) {
    const delta = choice?.delta;
    if (!delta || typeof delta.content !== "string" || delta.content.length === 0) continue;

    const full = state.pending + delta.content;
    state.pending = "";

    let reasoning = "";
    let answer = "";
    let cursor = 0;
    for (const m of full.matchAll(MARKER_RE)) {
      const at = m.index ?? 0;
      const seg = full.slice(cursor, at);
      if (CLOSE_WITH_ID_RE.test(m[0])) reasoning += seg;
      else answer += seg;
      state.markersRemoved++;
      cursor = at + m[0].length;
    }
    answer += full.slice(cursor);

    // 尾部可能是被拆开的半个标记：暂扣到下一个事件再判定。
    const hold = partialMarkerTail(answer);
    if (hold) {
      state.pending = hold;
      answer = answer.slice(0, answer.length - hold.length);
    }

    if (reasoning.length > 0) {
      const existing = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
      delta.reasoning_content = existing + reasoning;
      state.charsToReasoning += reasoning.length;
    }
    if (answer !== full) touched = true;
    delta.content = answer;
  }

  if (!touched) return null;
  state.eventsRewritten++;
  return JSON.stringify(body);
}

/** 改写单行 SSE 文本（保留 `data:` 前缀与原始行内空白风格）。 */
export function rewriteSseLine(line: string, state: LeakRewriteState): string {
  if (!line.startsWith("data:")) return line;
  const raw = line.slice(5);
  const trimmed = raw.startsWith(" ") ? raw.slice(1) : raw;
  const payload = trimmed.endsWith("\r") ? trimmed.slice(0, -1) : trimmed;
  const rewritten = rewriteDataPayload(payload, state);
  if (rewritten === null) return line;
  return `data: ${rewritten}${trimmed.endsWith("\r") ? "\r" : ""}`;
}

/**
 * 包一层 SSE 字节流：按行处理（SSE 行以 \n 结尾），非 `data:` 行原样透传。
 * 流结束时把暂扣的 `pending` 以一条额外 SSE 事件补发（`[DONE]` 之后不再补发）。
 */
export function rewriteLeakedReasoningStream(
  source: ReadableStream<Uint8Array>,
  state: LeakRewriteState,
  onEnd?: (state: LeakRewriteState) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  let buf = "";
  let sawDone = false;

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!sawDone && line.startsWith("data:") && line.includes("[DONE]")) sawDone = true;
          controller.enqueue(encoder.encode(rewriteSseLine(line, state) + "\n"));
        }
      },
      flush(controller) {
        buf += decoder.decode();
        if (buf.length > 0) {
          if (!sawDone && buf.startsWith("data:") && buf.includes("[DONE]")) sawDone = true;
          controller.enqueue(encoder.encode(rewriteSseLine(buf, state)));
        }
        // 补发暂扣文本：它从未上线过，丢掉会少 1~2 个字符的正文。
        if (state.pending.length > 0 && !sawDone) {
          const evt = { choices: [{ index: 0, delta: { content: state.pending } }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n`));
        }
        state.pending = "";
        onEnd?.(state);
      },
    }),
  );
}

/** 该响应是否是需要改写的 SSE 流。 */
export function isEventStreamResponse(contentType: string | null): boolean {
  return typeof contentType === "string" && /text\/event-stream|application\/ndjson/i.test(contentType);
}

/** 供扩展入口注册的一次性日志摘要（避免每事件刷屏）。 */
export function summarizeLeakRewrite(state: LeakRewriteState, logger: Logger | undefined): void {
  if (!logger || state.eventsRewritten === 0) return;
  logger.warn(
    `leaked reasoning normalized: ${state.markersRemoved} marker(s) removed, ` +
      `${state.charsToReasoning} char(s) moved to thinking across ${state.eventsRewritten} event(s)`,
  );
}
