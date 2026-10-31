import { describe, it, expect, vi } from "vitest";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { remoteModelToPi, DEFAULT_MODEL, DiscoveryCache } from "../src/models.js";
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
});

describe("DiscoveryCache 瞬时失败降级保护", () => {
  it("失败且无旧数据 → 返回 null，不缓存 [auto] 兜底", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const c = new DiscoveryCache({ ttlMs: 60_000, fetchFn });
    await expect(c.get("t", {})).resolves.toBeNull();
    // 原实现会把 [DEFAULT_MODEL] 当成功结果缓存 5min TTL；修复后失败不缓存，下次仍会重试
    await expect(c.get("t", {})).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("有旧数据时瞬时失败 → 返回旧数据（不降级）", async () => {
    let fail = false;
    const good = [{ id: "m1", name: "M1" }];
    const fetchFn = vi.fn().mockImplementation(() => fail ? Promise.reject(new Error("boom")) : Promise.resolve(good));
    const c = new DiscoveryCache({ ttlMs: 20, fetchFn });
    const first = await c.get("t", {});
    expect(first).toEqual(good);
    await new Promise((r) => setTimeout(r, 30)); // TTL 过期
    fail = true;
    const second = await c.get("t", {}); // stale-while-revalidate：旧数据兜住
    expect(second).toEqual(good);
  });

  it("401/403 上抛（不吞）", async () => {
    const e = Object.assign(new Error("discovery 401"), { status: 401 });
    const c = new DiscoveryCache({ ttlMs: 1000, fetchFn: vi.fn().mockRejectedValue(e) });
    await expect(c.get("t", {})).rejects.toMatchObject({ status: 401 });
  });
});
