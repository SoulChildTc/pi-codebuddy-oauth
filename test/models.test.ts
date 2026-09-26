import { describe, it, expect } from "vitest";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { remoteModelToPi, DEFAULT_MODEL } from "../src/models.js";
import type { RemoteModel } from "../src/models.js";

describe("models (pi)", () => {
  it("remoteModelToPi 基本字段映射", () => {
    const m: RemoteModel = {
      id: "claude-x", name: "Claude X",
      maxInputTokens: 200000, maxOutputTokens: 32000,
      supportsToolCall: true, supportsImages: true,
      supportsReasoning: true,
      reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high"] },
    };
    const p = remoteModelToPi(m);
    expect(p.id).toBe("claude-x");
    expect(p.name).toBe("Claude X");
    expect(p.contextWindow).toBe(200000);
    expect(p.maxTokens).toBe(32000);
    expect(p.reasoning).toBe(true);
    expect(p.input).toEqual(["text", "image"]);
    expect(p.thinkingLevelMap).toEqual({ low: "low", high: "high", default: "high" });
    expect(p.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
  it("maxAllowedSize 优先于 maxInputTokens", () => {
    const p = remoteModelToPi({ id: "a", name: "A", maxAllowedSize: 256000, maxInputTokens: 128000 });
    expect(p.contextWindow).toBe(256000);
  });
  it("缺省尺寸走 DEFAULT", () => {
    const p = remoteModelToPi({ id: "a", name: "A" });
    expect(p.contextWindow).toBe(131_072);
    expect(p.maxTokens).toBe(8192);
  });
  it("disabledMultimodal 关闭图片输入", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsImages: true, disabledMultimodal: true });
    expect(p.input).toEqual(["text"]);
  });
  it("reasoning 模型强制 system 角色（CodeBuddy 拒绝 developer → 400）", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsReasoning: true });
    expect(p.compat?.supportsDeveloperRole).toBe(false);
    const model: any = { ...p, api: "openai-completions", provider: "codebuddy", baseUrl: "https://x/v2" };
    const captured: any[] = [];
    const fetchFn = (async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })) as any;
    const stream = openAICompletionsApi().streamSimple(
      model,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] } as any,
      { apiKey: "x", fetch: fetchFn, onPayload: ((pl: any) => { captured.push(pl); return undefined; }) as any },
    );
    return (async () => {
      for await (const _ of stream) { /* drain */ }
      expect(captured[0].messages[0].role).toBe("system");
    })();
  });
  it("非推理模型无 thinkingLevelMap", () => {
    const p = remoteModelToPi({ id: "plain", name: "P", supportsReasoning: false });
    expect(p.reasoning).toBe(false);
    expect(p.thinkingLevelMap).toBeUndefined();
  });
  it("DEFAULT_MODEL 具备最小可用字段", () => {
    const p = remoteModelToPi(DEFAULT_MODEL);
    expect(p.id).toBe("auto");
    expect(p.contextWindow).toBe(168000);
    expect(p.maxTokens).toBe(32000);
  });
  it("hy4-preview 是推理模型（旧实现写死 hy3 导致被误判为非推理）", () => {
    const m = remoteModelToPi({ id: "hy4-preview", name: "Hy4 preview" });
    expect(m.reasoning).toBe(true);
    // 上游未公布 effort 词表时不下发 reasoning_effort，保持请求形状不变
    expect(m.compat?.supportsReasoningEffort).toBe(false);
    expect(m.thinkingLevelMap).toBeUndefined();
  });
  it("上游 supportsReasoning=true 时不再被 ID 猜测覆盖", () => {
    expect(remoteModelToPi({ id: "mystery-9", name: "M", supportsReasoning: true }).reasoning).toBe(true);
    expect(remoteModelToPi({ id: "mystery-9", name: "M" }).reasoning).toBe(false);
  });
  it("公布 effort 词表的推理模型仍可下发 reasoning_effort", () => {
    const m = remoteModelToPi({
      id: "hy3", name: "Hy3", supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "high" },
    });
    expect(m.reasoning).toBe(true);
    expect(m.compat?.supportsReasoningEffort).toBeUndefined();
    expect(m.thinkingLevelMap).toEqual({ low: "low", high: "high", default: "high" });
  });
});


