// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/models.ts — 平移自 opencode-codebuddy-oauth；RemoteModel → Pi ProviderModelConfig
import { fetchJson } from "./fetch-json.js";
import { AGENT_INTENT, DISCOVERY_TIMEOUT_MS, IDE_NAME, IDE_TYPE, IDE_VERSION, APP_VERSION, ENV_ID, PRODUCT } from "./config.js";
import { priceLabelForModel, type RemotePromotion } from "./pricing.js";

export interface RemoteModel { id:string; name:string; maxInputTokens?:number; maxOutputTokens?:number; maxAllowedSize?:number; supportsToolCall?:boolean; supportsImages?:boolean; supportsReasoning?:boolean; disabledMultimodal?:boolean; credits?:string; reasoning?:{ effort?:string; defaultEffort?:string; supportedEfforts?:string[] }; }
export const DEFAULT_MODEL: RemoteModel = { id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true };

// 与 Pi 类型定义匹配的接口
export interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string>;
  compat?: { supportsDeveloperRole?: boolean };
  // 采样参数（温度、top_p 等）
  samplingParams?: Record<string, unknown>;
  // 提示缓存配置（与 Pi 的 ModelPromptCache 匹配）
  promptCache?: {
    long?: number;   // 长期缓存预热时间（秒）
    short?: number;  // 短期缓存预热时间（秒）
  };
  // 输入限制（与 Pi 的 ModelInputLimits 匹配）
  inputLimits?: {
    maxRequestBytes?: number;
    images?: {
      resize?: {
        maxWidth?: number;
        maxHeight?: number;
        maxBytes?: number;
        jpegQuality?: number;
      };
      maxPerMessage?: number;
      maxPerRequest?: number;
    };
  };
}

export interface RemoteConfigResponse { code:number; data?:{ agents?:Array<{name:string; models?:string[]}>; models?:RemoteModel[]; modelPromotions?:RemotePromotion[] } }

/** /v3/config 的模型列表 + 促销信息（促销按时段动态生效，随模型一起缓存/刷新） */
export interface RemoteConfig { models: RemoteModel[]; promotions: RemotePromotion[] }
export async function fetchRemoteConfig(
  accessToken: string,
  server: { url: string; domain: string },
  signal?: AbortSignal,
): Promise<RemoteConfig> {
  const headers: Record<string,string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": AGENT_INTENT,
    "X-IDE-Type": IDE_TYPE, "X-IDE-Name": IDE_NAME, "X-IDE-Version": IDE_VERSION,
    "X-Product-Version": APP_VERSION, "X-Env-ID": ENV_ID,
    "X-Domain": server.domain, "X-Product": PRODUCT,
    "User-Agent": `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
  };
  const res = await fetchJson<RemoteConfigResponse>(`${server.url}/v3/config`, {
    headers, timeoutMs: DISCOVERY_TIMEOUT_MS, signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`discovery ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    return { models: [], promotions: [] };
  }
  const body = res.data;
  if (!body || body.code !== 0 || !body.data) return { models: [], promotions: [] };
  const allModels = body.data.models || [];
  const promotions = body.data.modelPromotions || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === AGENT_INTENT);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return { models: [DEFAULT_MODEL], promotions };
  const models = craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false);
  return { models, promotions };
}

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_TOKENS = 8192;

function detectThinking(id: string): boolean {
  return /claude|gemini|gpt-5|hy3|deepseek|glm/i.test(id);
}

/** RemoteModel → Pi ProviderModelConfig 所需字段。
 *  promotions 传入时把积分价格/当前生效折扣拼进 name（pi 的模型选择器
 *  详情行只渲染 name，是唯一能展示价格的入口；搜索文本也包含 name）。 */
export function remoteModelToPi(m: RemoteModel, promotions?: RemotePromotion[]): PiModelConfig {
  const contextWindow = m.maxAllowedSize ?? m.maxInputTokens ?? DEFAULT_CONTEXT;
  const maxTokens = m.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const priceLabel = priceLabelForModel(m.credits, promotions, m.id);
  const cfg: PiModelConfig = {
    id: m.id,
    name: priceLabel ? `${m.name} · ${priceLabel}` : m.name,
    reasoning: m.supportsReasoning !== false && detectThinking(m.id),
    input: (m.supportsImages && !m.disabledMultimodal) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    // CodeBuddy 网关不接受 assistant-role 之外的 system→developer 角色：pi-ai 对
    // reasoning 模型默认发 role:"developer" 承载 systemPrompt，网关返回 400 (code 11128)，
    // 且 body 无 error 字段 → OpenAI SDK 报 "400 status code (no body)"。强制回退 system。
    compat: { supportsDeveloperRole: false },
  };
  const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
  const efforts = m.reasoning?.supportedEfforts;
  if (cfg.reasoning && efforts?.length) {
    cfg.thinkingLevelMap = Object.fromEntries(efforts.map((e) => [e, e]));
    if (effort) cfg.thinkingLevelMap.default = effort;
  }
  // 多模态支持：如果模型支持图片输入，添加 inputLimits 配置
  if (m.supportsImages && !m.disabledMultimodal) {
    cfg.inputLimits = {
      maxRequestBytes: 100 * 1024 * 1024, // 100MB
      images: {
        resize: {
          maxWidth: 4096,
          maxHeight: 4096,
          maxBytes: 10 * 1024 * 1024, // 10MB
          jpegQuality: 85,
        },
        maxPerMessage: 10,
        maxPerRequest: 10,
      },
    };
  }
  // 提示缓存：CodeBuddy 支持 prompt cache
  // short: 5分钟，long: 1小时
  cfg.promptCache = {
    short: 300,
    long: 3600,
  };
  return cfg;
}

export class DiscoveryCache {
  private data: RemoteConfig | null = null;
  private fetchedAt = 0;
  private inflight: Promise<RemoteConfig> | null = null;
  private readonly fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteConfig>;
  constructor(private opts: { ttlMs:number; fetchFn: (token: string, signal?: AbortSignal)=>Promise<RemoteConfig> }) { this.fetchFn = opts.fetchFn; }
  async get(token:string, { signal }: { signal?:AbortSignal }): Promise<RemoteConfig> {
    const now = Date.now();
    if (this.data && (now - this.fetchedAt) < this.opts.ttlMs) return this.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchFn(token, signal).then(d => { this.data = d; this.fetchedAt = Date.now(); return d; }).catch(e => {
      if ((e as any)?.status === 401 || (e as any)?.status === 403) throw e;
      if (!this.data) { this.data = { models: [DEFAULT_MODEL], promotions: [] }; this.fetchedAt = now; return this.data; }
      return this.data;
    }).finally(() => { this.inflight = null; });
    if (this.data) { this.inflight.catch(() => {}); return this.data; }
    return this.inflight;
  }
}
