import type { RiskLevel } from "../../types/analysis";
import { THRESHOLDS } from "../rules/weights";

export function toRiskLevel(scoreTotal: number, hardHigh: boolean): RiskLevel {
  // ✅ 정책: high는 hardHigh에서만 허용
  if (hardHigh) return "high";

  // ✅ 정책: hardHigh가 아니면 score로는 최대 medium까지만
  if (scoreTotal >= THRESHOLDS.medium) return "medium";
  return "low";
}
