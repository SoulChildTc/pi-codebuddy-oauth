// SPDX-License-Identifier: MIT
// src/pricing.ts — CodeBuddy 积分定价与促销信息解析（数据来自 /v3/config）
//
// /v3/config 返回两类定价数据，此前扩展完全没有消费：
// 1. models[].credits —— 每模型积分单价，形如 "x0.79"（"x" 前缀 + 数值，单位：积分）
// 2. modelPromotions —— 促销列表，含折扣系数（factor）、每日时段（schedule.daily，
//    带时区）、有效期（validFrom/validUntil）。折扣按时段动态生效（如 glm-5.2 夜间 5 折），
//    所以"当前价格"随时间变化，注册时算一次 name、footer 里按 turn 动态刷新。

export interface RemotePromotionBadge { label?: string; color?: string; display?: string }
export interface RemotePromotionDiscount { factor?: number; discountedCredits?: string; displayMode?: string }
export interface RemotePromotionScheduleWindow { start?: string; end?: string }
export interface RemotePromotionSchedule {
  timezone?: string;
  validFrom?: string;
  validUntil?: string;
  daily?: RemotePromotionScheduleWindow[];
}
export interface RemotePromotion {
  id?: string;
  kind?: string;
  enabled?: boolean;
  priority?: number;
  modelIds?: string[];
  badge?: RemotePromotionBadge;
  discount?: RemotePromotionDiscount;
  schedule?: RemotePromotionSchedule;
  hover?: { textZh?: string; textEn?: string };
}

/** "x0.79" → 0.79；空串/无效输入 → null。 */
export function parseCredits(credits: string | undefined | null): number | null {
  if (typeof credits !== "string" || credits.trim() === "") return null;
  const n = Number(credits.trim().replace(/^x/i, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 数字 → 紧凑积分文本：0.79 → "0.79"，0.4 → "0.4"，0 → "0"。 */
export function formatCreditsValue(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 折扣系数 → 中文折扣描述：0.5 → "5折"，0.75 → "7.5折"，0.333 → "3.3折"。 */
export function formatFactor(factor: number): string {
  return `${Math.round(factor * 100) / 10}折`;
}

function parseHm(hm: string | undefined): number | null {
  if (typeof hm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 时刻（分钟）是否落在窗口内；支持跨午夜窗口（start > end，如 23:00–07:50）。 */
export function inDailyWindow(minutes: number, window: RemotePromotionScheduleWindow): boolean {
  const start = parseHm(window.start);
  const end = parseHm(window.end);
  if (start === null) return false;
  if (end === null) return minutes >= start;
  if (start <= end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/** now 在指定时区的当日分钟数（0–1439）。时区无效时退回本地时间。 */
export function minutesOfDayInZone(now: Date, timeZone: string | undefined): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || undefined,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return (hour % 24) * 60 + minute;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

/** 促销此刻是否生效：enabled、有效期（含端点前，不含 until）、每日时段。 */
export function isPromotionActive(p: RemotePromotion, now: Date = new Date()): boolean {
  if (p.enabled === false) return false;
  const s = p.schedule;
  if (s?.validFrom && now.getTime() < Date.parse(s.validFrom)) return false;
  if (s?.validUntil && now.getTime() >= Date.parse(s.validUntil)) return false;
  if (s?.daily && s.daily.length > 0) {
    const minutes = minutesOfDayInZone(now, s.timezone);
    return s.daily.some((w) => inDailyWindow(minutes, w));
  }
  // 无时段限定 → 有效期/启用期内全程生效
  return true;
}

/** 该模型当前生效的最高优先级促销（priority 缺省 0）。 */
export function bestPromotion(
  promotions: RemotePromotion[] | undefined,
  modelId: string,
  now: Date = new Date(),
): RemotePromotion | undefined {
  if (!promotions?.length) return undefined;
  return promotions
    .filter((p) => p.kind === "discount" && (p.modelIds ?? []).includes(modelId) && isPromotionActive(p, now))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
}

/** 该模型是否存在促销（不论是否生效）——用于 footer 提示即将到来的折扣时段。 */
export function anyPromotion(
  promotions: RemotePromotion[] | undefined,
  modelId: string,
): RemotePromotion | undefined {
  if (!promotions?.length) return undefined;
  return promotions
    .filter((p) => p.kind === "discount" && (p.modelIds ?? []).includes(modelId))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
}

/** 促销的时段/有效期人类可读描述："23:00–07:50"、"至11/01"。 */
export function promotionWindowText(p: RemotePromotion): string {
  const s = p.schedule;
  const windows = (s?.daily ?? [])
    .map((w) => (w.start && w.end ? `${w.start}–${w.end}` : w.start || w.end || ""))
    .filter(Boolean)
    .join("、");
  const until = s?.validUntil ? `至${formatDateInZone(s.validUntil, s.timezone)}` : "";
  return [windows, until].filter(Boolean).join(" ");
}

function formatDateInZone(iso: string, timeZone: string | undefined): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || undefined, month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(t));
    const month = parts.find((p) => p.type === "month")?.value ?? "??";
    const day = parts.find((p) => p.type === "day")?.value ?? "??";
    return `${month}/${day}`;
  } catch {
    return new Date(t).toISOString().slice(5, 10);
  }
}

/**
 * 模型选择器详情行用的价格后缀（不含分隔符）：
 *   factor 0          → "限时免费" / badge 文案
 *   factor<1 且有单价 → "0.4分(夜间折扣5折)"
 *   仅促销无单价      → badge 文案
 *   仅单价            → "0.79分"（0 单价 → "免费"）
 *   都没有           → undefined（name 保持原样）
 */
export function priceLabelForModel(
  credits: string | undefined,
  promotions: RemotePromotion[] | undefined,
  modelId: string,
  now: Date = new Date(),
): string | undefined {
  const base = parseCredits(credits);
  const promo = bestPromotion(promotions, modelId, now);
  const factor = promo?.discount?.factor;
  const badge = promo?.badge?.label;
  if (promo && factor === 0) return badge || "限时免费";
  if (promo && factor !== undefined && factor > 0 && factor < 1) {
    const discounted = base !== null ? formatCreditsValue(base * factor) : undefined;
    const zhe = formatFactor(factor);
    return discounted !== undefined ? `${discounted}分(${badge || "折扣"}${zhe})` : `${badge || "折扣"}${zhe}`;
  }
  if (promo) {
    // 角标型促销（无 discount 字段，如 deepseek "错峰使用"）：保留价格 + 角标
    const baseText = base === null ? undefined : base === 0 ? "免费" : `${formatCreditsValue(base)}分`;
    if (baseText && badge) return `${baseText}(${badge})`;
    return baseText ?? badge;
  }
  if (base === null) return undefined;
  return base === 0 ? "免费" : `${formatCreditsValue(base)}分`;
}

/**
 * Footer 状态行文案（动态，随当前时段计算）：
 *   "codebuddy glm-5.2 0.4分(夜间折扣5折)"
 *   "codebuddy glm-5.2 0.79分 · 夜间折扣 23:00–07:50"（有折扣但当前不生效）
 *   "codebuddy hy3 限时免费"
 * 无任何定价信息 → undefined（调用方清掉状态）
 */
export function priceStatusForModel(
  modelId: string,
  credits: string | undefined,
  promotions: RemotePromotion[] | undefined,
  now: Date = new Date(),
): string | undefined {
  const base = parseCredits(credits);
  const active = bestPromotion(promotions, modelId, now);
  const label = priceLabelForModel(credits, promotions, modelId, now);
  if (active) return `${modelId} ${label}`;
  const upcoming = anyPromotion(promotions, modelId);
  if (upcoming) {
    const window = promotionWindowText(upcoming);
    const baseText = base === null ? "" : base === 0 ? "免费" : `${formatCreditsValue(base)}分`;
    const hint = upcoming.badge?.label || "折扣";
    return [modelId, baseText, `· ${hint}${window ? ` ${window}` : ""}`].filter(Boolean).join(" ");
  }
  if (base === null) return undefined;
  return `${modelId} ${label ?? "免费"}`;
}
