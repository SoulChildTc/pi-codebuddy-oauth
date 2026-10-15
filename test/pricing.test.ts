import { describe, it, expect } from "vitest";
import {
  parseCredits, formatCreditsValue, formatFactor,
  inDailyWindow, minutesOfDayInZone, isPromotionActive, bestPromotion, anyPromotion,
  promotionWindowText, priceLabelForModel, priceStatusForModel,
  type RemotePromotion,
} from "../src/pricing.js";

describe("pricing (parse/format)", () => {
  it("parseCredits 处理 x 前缀与无效输入", () => {
    expect(parseCredits("x0.79")).toBe(0.79);
    expect(parseCredits("x0.00")).toBe(0);
    expect(parseCredits("  X1.62 ")).toBe(1.62);
    expect(parseCredits(undefined)).toBeNull();
    expect(parseCredits("")).toBeNull();
    expect(parseCredits("abc")).toBeNull();
    expect(parseCredits("-1")).toBeNull();
    expect(parseCredits("x")).toBeNull(); // 无数字，不能误判为 0（免费）
    expect(parseCredits("x.")).toBeNull();
  });
  it("formatCreditsValue 紧凑显示", () => {
    expect(formatCreditsValue(0.79)).toBe("0.79");
    expect(formatCreditsValue(0.4)).toBe("0.4");
    expect(formatCreditsValue(0.395)).toBe("0.4");
    expect(formatCreditsValue(0)).toBe("0");
  });
  it("formatFactor 转中文折扣", () => {
    expect(formatFactor(0.5)).toBe("5折");
    expect(formatFactor(0.75)).toBe("7.5折");
    expect(formatFactor(0.333)).toBe("3.3折");
  });
});

describe("pricing (时段)", () => {
  it("同日窗口", () => {
    expect(inDailyWindow(9 * 60, { start: "8:00", end: "12:00" })).toBe(true);
    expect(inDailyWindow(7 * 60, { start: "8:00", end: "12:00" })).toBe(false);
    expect(inDailyWindow(12 * 60, { start: "8:00", end: "12:00" })).toBe(false); // end 不含
  });
  it("跨午夜窗口 23:00–07:50", () => {
    const w = { start: "23:00", end: "07:50" };
    expect(inDailyWindow(23 * 60 + 30, w)).toBe(true);
    expect(inDailyWindow(3 * 60, w)).toBe(true);
    expect(inDailyWindow(7 * 60 + 50, w)).toBe(false); // end 不含
    expect(inDailyWindow(12 * 60, w)).toBe(false);
  });
  it("minutesOfDayInZone 按时区计算（固定 UTC 时刻）", () => {
    const now = new Date("2026-10-15T15:30:00Z"); // 北京时间 23:30
    expect(minutesOfDayInZone(now, "Asia/Shanghai")).toBe(23 * 60 + 30);
    expect(minutesOfDayInZone(now, "UTC")).toBe(15 * 60 + 30);
  });
});

describe("pricing (促销状态)", () => {
  const night: RemotePromotion = {
    id: "glm-52-night", kind: "discount", enabled: true, priority: 100,
    modelIds: ["glm-5.2"], badge: { label: "夜间折扣" },
    discount: { factor: 0.5, discountedCredits: "0.50x" },
    schedule: { timezone: "Asia/Shanghai", daily: [{ start: "23:00", end: "07:50" }] },
  };
  const free: RemotePromotion = {
    id: "hy3-free", kind: "discount", enabled: true, priority: 200,
    modelIds: ["hy3"], badge: { label: "限时免费", display: "activeOnly" },
    discount: { factor: 0 },
    schedule: { timezone: "Asia/Shanghai", validFrom: "2026-07-06T00:00:00+08:00", validUntil: "2026-11-01T00:00:00+08:00" },
  };
  const expired: RemotePromotion = {
    id: "bunny-expired", kind: "discount", enabled: true,
    modelIds: ["space-bunny"], badge: { label: "限时折扣" },
    schedule: { validFrom: "2026-10-02T00:00:00+08:00", validUntil: "2026-10-08T00:00:00+08:00" },
  };

  it("夜间时段内生效，白天不生效", () => {
    const night2330 = new Date("2026-10-15T15:30:00Z"); // 北京 23:30
    const noon = new Date("2026-10-15T04:00:00Z"); // 北京 12:00
    expect(isPromotionActive(night, night2330)).toBe(true);
    expect(isPromotionActive(night, noon)).toBe(false);
    expect(isPromotionActive(free, noon)).toBe(true);
    expect(isPromotionActive(expired, noon)).toBe(false);
  });
  it("disabled 不生效", () => {
    expect(isPromotionActive({ ...night, enabled: false }, new Date("2026-10-15T15:30:00Z"))).toBe(false);
  });
  it("bestPromotion 按 priority 取最高，anyPromotion 不看时段", () => {
    const noon = new Date("2026-10-15T04:00:00Z");
    const promos = [night, free, expired];
    expect(bestPromotion(promos, "glm-5.2", noon)).toBeUndefined();
    expect(bestPromotion(promos, "glm-5.2", new Date("2026-10-15T15:30:00Z"))).toBe(night);
    expect(anyPromotion(promos, "glm-5.2", noon)).toBe(night); // 白天也返回（用于"即将折扣"提示）
    expect(anyPromotion(promos, "hy3", noon)).toBe(free);
    expect(anyPromotion(promos, "unknown", noon)).toBeUndefined();
  });
  it("anyPromotion 排除已过期/未开始/已禁用的促销（footer 不展示死折扣）", () => {
    const noon = new Date("2026-10-15T04:00:00Z");
    // expired 的有效期 2026-10-02~10-08，早已过
    expect(anyPromotion([expired], "space-bunny", noon)).toBeUndefined();
    // 未开始
    const future: RemotePromotion = {
      kind: "discount", enabled: true, modelIds: ["m"],
      schedule: { validFrom: "2027-01-01T00:00:00+08:00" },
    };
    expect(anyPromotion([future], "m", noon)).toBeUndefined();
    // 已禁用
    expect(anyPromotion([{ ...night, enabled: false }], "glm-5.2", noon)).toBeUndefined();
  });
  it("promotionWindowText 输出时段与有效期", () => {
    expect(promotionWindowText(night)).toBe("23:00–07:50");
    expect(promotionWindowText(free)).toContain("至11/01"); // validUntil 是 2026-11-01T00:00+08:00（即10/31结束后）
  });
});

describe("pricing (价格标签)", () => {
  const free: RemotePromotion = {
    kind: "discount", enabled: true, priority: 200, modelIds: ["hy3"],
    badge: { label: "限时免费" }, discount: { factor: 0 },
    schedule: { validUntil: "2026-11-01T00:00:00+08:00" },
  };
  const night: RemotePromotion = {
    kind: "discount", enabled: true, priority: 100, modelIds: ["glm-5.2"],
    badge: { label: "夜间折扣" }, discount: { factor: 0.5 },
    schedule: { timezone: "Asia/Shanghai", daily: [{ start: "23:00", end: "07:50" }] },
  };
  const nightBeijing = new Date("2026-10-15T15:30:00Z");
  const noonBeijing = new Date("2026-10-15T04:00:00Z");

  it("仅单价", () => {
    expect(priceLabelForModel("x0.79", undefined, "glm-5.3")).toBe("0.79分");
    expect(priceLabelForModel("x0.00", undefined, "x")).toBe("免费");
    expect(priceLabelForModel(undefined, undefined, "x")).toBeUndefined();
  });
  it("生效折扣改写价格", () => {
    expect(priceLabelForModel("x0.79", [night], "glm-5.2", nightBeijing)).toBe("0.4分(夜间折扣5折)");
    expect(priceLabelForModel("x0.00", [free], "hy3", noonBeijing)).toBe("限时免费");
  });
  it("折扣不生效时显示原价", () => {
    expect(priceLabelForModel("x0.79", [night], "glm-5.2", noonBeijing)).toBe("0.79分");
  });
  it("角标型促销（无 discount 字段）保留价格 + 角标", () => {
    const badgeOnly: RemotePromotion = {
      kind: "discount", enabled: true, modelIds: ["deepseek-v4-pro"],
      badge: { label: "错峰使用" },
      schedule: { daily: [{ start: "00:00", end: "23:59" }] },
    };
    expect(priceLabelForModel("x0.51", [badgeOnly], "deepseek-v4-pro", noonBeijing)).toBe("0.51分(错峰使用)");
  });
  it("footer 状态行", () => {
    // 生效中
    expect(priceStatusForModel("glm-5.2", "x0.79", [night], nightBeijing)).toBe("glm-5.2 0.4分(夜间折扣5折)");
    // 白天：显示原价 + 即将折扣时段提示
    expect(priceStatusForModel("glm-5.2", "x0.79", [night], noonBeijing)).toBe("glm-5.2 0.79分 · 夜间折扣 23:00–07:50");
    // 免费
    expect(priceStatusForModel("hy3", "x0.00", [free], noonBeijing)).toBe("hy3 限时免费");
    // 无任何定价信息
    expect(priceStatusForModel("m", undefined, undefined)).toBeUndefined();
    // 生效中但 label 无法生成（无 badge/无单价的角标促销）→ 不能渲染字面 "undefined"
    const badgeOnlyNoCredits: RemotePromotion = {
      kind: "discount", enabled: true, modelIds: ["m2"],
      schedule: { daily: [{ start: "00:00", end: "23:59" }] },
    };
    expect(priceStatusForModel("m2", undefined, [badgeOnlyNoCredits], noonBeijing)).toBe("m2");
  });
});
