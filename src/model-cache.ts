// SPDX-License-Identifier: MIT
// src/model-cache.ts — 持久化已发现的模型列表，消除启动时的模型发现竞态
//
// 问题：会话恢复走同步路径，而模型发现（GET /v3/config）是异步且带 5s 超时。
// 扩展初始化时只注册了 fallback（仅 `auto`），随后才 `void discoverAndReregister(...)`。
// 若会话在发现返回前恢复，getModel("codebuddy","hy4-preview") === undefined
//   → warning "Could not restore model ... (model no longer exists)"
//   → 回落到 auto，表现为"每次都得重新配一次模型"。
//
// 方案：把上次成功发现的模型落盘，启动时先同步载入缓存再注册，
// 网络发现完成后刷新缓存。缓存只是启动期的种子，不替代网络发现。
//
// v2（促销/价格接入后）：缓存存 /v3/config 的**原始** RemoteModel + promotions，
// 启动时经 remoteModelToPi 重新映射。这样映射逻辑升级（如多模态、价格标签）
// 会自动作用于缓存种子，旧逻辑生成的 PiModelConfig 不会无限期滞留。
//
// 刻意不写 models.json：codebuddy 是扩展注册的 provider，其鉴权由 auth-fetch
// 拦截器注入（自定义 streamSimple）。在 models.json 里声明同 id 的原生 provider
// 会引入 baseUrl/api 的重复定义，并可能与 pi-model-manager 的跨进程锁相互干扰。
import * as fs from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { RemoteConfig, RemoteModel } from "./models.js";
import type { RemotePromotion } from "./pricing.js";

// v1: PiModelConfig[]；v2: 原始 RemoteModel[] + promotions（启动时重新映射）
const CACHE_VERSION = 2;
// 缓存过期只用于日志提示；过期后仍会作为启动种子使用（有 15 个模型好过只有 auto）
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheDocument {
  version: number;
  updatedAt: number;
  remote?: RemoteModel[];
  promotions?: RemotePromotion[];
}

export function getModelCachePath(): string {
  return join(homedir(), CONFIG_DIR_NAME || ".pi", "agent", "codebuddy-models-cache.json");
}

function isValidRemoteModel(value: unknown): value is RemoteModel {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.id === "string" && m.id.length > 0;
}

/** 读取缓存的模型配置；缺失、损坏、版本过旧或为空时返回 undefined。永不抛错。 */
export async function readCachedConfig(): Promise<RemoteConfig | undefined> {
  try {
    const raw = await fs.readFile(getModelCachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheDocument>;
    if (parsed?.version !== CACHE_VERSION) return undefined;
    if (!Array.isArray(parsed.remote)) return undefined;
    const models = parsed.remote.filter(isValidRemoteModel);
    if (models.length === 0) return undefined;
    const promotions = Array.isArray(parsed.promotions) ? parsed.promotions : [];
    if (typeof parsed.updatedAt === "number" && Date.now() - parsed.updatedAt > STALE_AFTER_MS) {
      // 过期但仍返回：种子再旧也比只有 auto 强，发现成功后会被覆盖
    }
    return { models, promotions };
  } catch {
    return undefined;
  }
}

/** 写入缓存（先写临时文件再 rename，避免读到半截内容）。永不抛错。 */
export async function writeCachedConfig(config: RemoteConfig): Promise<void> {
  if (!config?.models.length) return;
  const path = getModelCachePath();
  const doc: CacheDocument = {
    version: CACHE_VERSION,
    updatedAt: Date.now(),
    remote: config.models,
    promotions: config.promotions,
  };
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
    await fs.rename(tmp, path);
  } catch {
    // 缓存写失败不影响运行，下次仍会重新发现
  }
}
