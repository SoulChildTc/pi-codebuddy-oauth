import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { RemoteModel } from "../src/models.js";

// 缓存路径由 homedir() 推导，测试前把 HOME 指到临时目录，避免污染真实 ~/.pi
const tmpHome = await fs.mkdtemp(join(os.tmpdir(), "cb-cache-test-"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome };
});

const { readCachedConfig, writeCachedConfig, getModelCachePath } = await import("../src/model-cache.js");

function remote(id: string, extra: Partial<RemoteModel> = {}): RemoteModel {
  return { id, name: id, ...extra };
}

describe("model-cache", () => {
  const cachePath = getModelCachePath();

  beforeEach(async () => {
    await fs.rm(cachePath, { force: true });
  });
  afterEach(async () => {
    await fs.rm(cachePath, { force: true });
  });

  it("缓存路径落在 pi agent 目录下", () => {
    expect(cachePath).toContain("codebuddy-models-cache.json");
  });

  it("无缓存时返回 undefined（不抛错）", async () => {
    await expect(readCachedConfig()).resolves.toBeUndefined();
  });

  it("写入后可原样读回（含促销）", async () => {
    const promo = { kind: "discount", modelIds: ["hy3"], discount: { factor: 0 } };
    await writeCachedConfig({ models: [remote("hy4-preview", { maxInputTokens: 1000000, maxOutputTokens: 64000, credits: "x0.29" })], promotions: [promo] });
    const got = await readCachedConfig();
    expect(got?.models).toHaveLength(1);
    expect(got?.models[0]!.id).toBe("hy4-preview");
    expect(got?.models[0]!.maxInputTokens).toBe(1000000);
    expect(got?.models[0]!.credits).toBe("x0.29");
    expect(got?.promotions).toEqual([promo]);
  });

  it("v1 旧格式（PiModelConfig[]）被废弃，返回 undefined", async () => {
    // 旧格式不含 remote 字段——版本迁移：启动时重新发现而非信任旧映射
    await fs.mkdir(join(tmpHome, ".pi", "agent"), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({ version: 1, updatedAt: Date.now(), models: [{ id: "old", name: "old", input: ["text"] }] }),
      "utf8",
    );
    await expect(readCachedConfig()).resolves.toBeUndefined();
  });

  it("空 models 不写盘（避免用空列表覆盖有效缓存）", async () => {
    await writeCachedConfig({ models: [remote("auto")], promotions: [] });
    await writeCachedConfig({ models: [], promotions: [] });
    expect((await readCachedConfig())?.models).toHaveLength(1);
  });

  it("损坏的 JSON 返回 undefined 而不抛错", async () => {
    await fs.mkdir(join(tmpHome, ".pi", "agent"), { recursive: true });
    await fs.writeFile(cachePath, "{{{broken", "utf8");
    await expect(readCachedConfig()).resolves.toBeUndefined();
  });

  it("version 不匹配返回 undefined", async () => {
    await fs.mkdir(join(tmpHome, ".pi", "agent"), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ version: 999, updatedAt: Date.now(), remote: [remote("x")] }), "utf8");
    await expect(readCachedConfig()).resolves.toBeUndefined();
  });

  it("过滤缺 id 的非法条目", async () => {
    await fs.mkdir(join(tmpHome, ".pi", "agent"), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({ version: 2, updatedAt: Date.now(), remote: [remote("keep"), { name: "no-id" }, "garbage"], promotions: [] }),
      "utf8",
    );
    const got = await readCachedConfig();
    expect(got?.models).toHaveLength(1);
    expect(got?.models[0]!.id).toBe("keep");
  });

  it("过期缓存仍作为启动种子返回（有模型好过只有 auto）", async () => {
    await fs.mkdir(join(tmpHome, ".pi", "agent"), { recursive: true });
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await fs.writeFile(cachePath, JSON.stringify({ version: 2, updatedAt: stale, remote: [remote("old")], promotions: [] }), "utf8");
    expect((await readCachedConfig())?.models).toHaveLength(1);
  });

  it("写入失败不抛出（只读环境下不阻断启动）", async () => {
    // 把 agent 目录替换成一个文件，mkdir 必然失败，验证 writeCachedConfig 不向上抛
    const agentDir = join(tmpHome, ".pi", "agent");
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.mkdir(join(tmpHome, ".pi"), { recursive: true });
    await fs.writeFile(agentDir, "not-a-dir", "utf8");
    await expect(writeCachedConfig({ models: [remote("x")], promotions: [] })).resolves.toBeUndefined();
    await fs.rm(agentDir, { force: true });
  });
});
