// src/engine/rules/weights.ts
export type Weights = typeof WEIGHTS;
export type Thresholds = typeof THRESHOLDS;

export const WEIGHTS = {
  link: 25,
  shortener: 30,

  urlHttp: 8,
  urlIpHost: 18,
  urlPunycode: 20,
  urlAtSign: 16,
  urlSuspiciousTld: 12,
  urlDeepSubdomain: 10,
  urlDownloadExt: 22,
  urlBrandMismatch: 26,

  otp: 22,
  personalInfo: 20,
  money: 18,
  urgency: 10,
  authority: 10,
  threat: 14,
  installRemote: 28,
  safeAccount: 22,

  investLure: 10,
  jobLure: 20,

  callOtp: 30,
  callRemote: 35,
  callUrgent: 15,
} as const;

export const THRESHOLDS = {
  medium: 35,
  high: 65,
} as const;

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function normalizeWeights(partial?: Partial<Record<keyof Weights, number>>): Weights {
  if (!partial) return WEIGHTS;
  const out: any = { ...WEIGHTS };
  for (const k of Object.keys(out)) {
    const key = k as keyof Weights;
    const v = partial[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out as Weights;
}

export function normalizeThresholds(partial?: Partial<Record<keyof Thresholds, number>>): Thresholds {
  if (!partial) return THRESHOLDS;
  const out: any = { ...THRESHOLDS };
  for (const k of Object.keys(out)) {
    const key = k as keyof Thresholds;
    const v = partial[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  // 정합성: medium < high 강제
  out.medium = clamp(out.medium, 0, 99);
  out.high = clamp(out.high, out.medium + 1, 200);
  return out as Thresholds;
}
