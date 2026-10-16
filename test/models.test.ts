import { describe, it, expect } from "vitest";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai";
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
    // pi-ai 1.x：provider 层只接受 TranscriptContext，systemPrompt/tools 必须先折叠进首条 system 消息
    const stream = openAICompletionsApi().streamSimple(
      model,
      normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] } as any),
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

  // ========== 多模态测试 ==========

  it("supportsImages=true 时 input 包含 image", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsImages: true });
    expect(p.input).toEqual(["text", "image"]);
  });

  it("supportsImages=false 时 input 只包含 text", () => {
    const p = remoteModelToPi({ id: "plain-x", name: "X", supportsImages: false });
    expect(p.input).toEqual(["text"]);
  });

  it("supportsImages 未设置时 input 只包含 text", () => {
    const p = remoteModelToPi({ id: "plain-x", name: "X" });
    expect(p.input).toEqual(["text"]);
  });

  it("supportsImages 未设置时回退 id 启发式（claude/gemini/gpt 系保留图片）", () => {
    expect(remoteModelToPi({ id: "claude-x", name: "X" }).input).toEqual(["text", "image"]);
    expect(remoteModelToPi({ id: "plain-x", name: "X" }).input).toEqual(["text"]);
    // 回退同时作用于 input 与 inputLimits 两处映射
    expect(remoteModelToPi({ id: "claude-x", name: "X" }).inputLimits).toBeDefined();
    expect(remoteModelToPi({ id: "plain-x", name: "X" }).inputLimits).toBeUndefined();
  });

  it("supportsImages 显式 false 时不做启发式回退", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsImages: false });
    expect(p.input).toEqual(["text"]);
    expect(p.inputLimits).toBeUndefined();
  });

  it("disabledMultimodal=true 时即使 supportsImages=true 也关闭图片", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsImages: true, disabledMultimodal: true });
    expect(p.input).toEqual(["text"]);
  });

  it("多模态模型生成 inputLimits 配置", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsImages: true });
    expect(p.inputLimits).toBeDefined();
    expect(p.inputLimits?.maxRequestBytes).toBe(200 * 1024 * 1024);
    expect(p.inputLimits?.images).toBeDefined();
    expect(p.inputLimits?.images?.maxPerMessage).toBe(10);
    expect(p.inputLimits?.images?.maxPerRequest).toBe(10);
    expect(p.inputLimits?.images?.resize).toBeDefined();
    expect(p.inputLimits?.images?.resize?.maxWidth).toBe(4096);
    expect(p.inputLimits?.images?.resize?.maxHeight).toBe(4096);
    expect(p.inputLimits?.images?.resize?.maxBytes).toBe(10 * 1024 * 1024);
    expect(p.inputLimits?.images?.resize?.jpegQuality).toBe(85);
    // review 反馈：maxRequestBytes 必须覆盖最坏情况（N 张 × 单张上限经 base64 编码 +33%）
    const worstCaseBytes =
      p.inputLimits!.images!.maxPerRequest! * p.inputLimits!.images!.resize!.maxBytes! * (4 / 3);
    expect(p.inputLimits!.maxRequestBytes!).toBeGreaterThanOrEqual(worstCaseBytes);
  });

  it("非多模态模型不生成 inputLimits 配置", () => {
    const p = remoteModelToPi({ id: "plain-x", name: "X", supportsImages: false });
    expect(p.inputLimits).toBeUndefined();
  });

  it("disabledMultimodal 模型不生成 inputLimits 配置", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X", supportsImages: true, disabledMultimodal: true });
    expect(p.inputLimits).toBeUndefined();
  });

  it("promptCache 配置正确生成", () => {
    const p = remoteModelToPi({ id: "claude-x", name: "X" });
    expect(p.promptCache).toBeDefined();
    expect(p.promptCache?.short).toBe(300);
    expect(p.promptCache?.long).toBe(3600);
  });

  it("多模态模型完整配置验证", () => {
    const m: RemoteModel = {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      maxInputTokens: 200000,
      maxOutputTokens: 32000,
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high"] },
    };
    const p = remoteModelToPi(m);
    // 基本字段
    expect(p.id).toBe("claude-sonnet-4");
    expect(p.name).toBe("Claude Sonnet 4");
    expect(p.contextWindow).toBe(200000);
    expect(p.maxTokens).toBe(32000);
    // 多模态
    expect(p.input).toEqual(["text", "image"]);
    expect(p.inputLimits).toBeDefined();
    expect(p.inputLimits?.images?.maxPerMessage).toBe(10);
    // 推理
    expect(p.reasoning).toBe(true);
    expect(p.thinkingLevelMap).toEqual({ low: "low", high: "high", default: "high" });
    // 缓存
    expect(p.promptCache).toEqual({ short: 300, long: 3600 });
    // 兼容性
    expect(p.compat?.supportsDeveloperRole).toBe(false);
  });
});
