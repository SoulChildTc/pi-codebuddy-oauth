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
  it("以网关 supportsImages 为准，不受模型 ID 白名单限制", () => {
    // 网关 /v3/config 对 craft agent 的 16 个模型（含 deepseek/glm/kimi/minimax/hunyuan）
    // 全标了 supportsImages=true，但 ID 不含 claude|gemini|gpt，旧实现一律降级为纯文本。
    for (const id of ["deepseek-v4.1-flash", "glm-5.3", "kimi-k3-1", "minimax-m3", "hy3"]) {
      expect(remoteModelToPi({ id, name: id, supportsImages: true }).input).toEqual(["text", "image"]);
    }
  });
  it("缺省 supportsImages 时回退 ID 白名单", () => {
    expect(remoteModelToPi({ id: "claude-x", name: "X" }).input).toEqual(["text", "image"]);
    expect(remoteModelToPi({ id: "deepseek-v4.1-flash", name: "D" }).input).toEqual(["text"]);
  });
  it("supportsImages=false 优先于 ID 白名单", () => {
    expect(remoteModelToPi({ id: "gemini-x", name: "G", supportsImages: false }).input).toEqual(["text"]);
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
});
