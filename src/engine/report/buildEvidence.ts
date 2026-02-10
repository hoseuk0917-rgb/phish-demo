import type { EvidenceItem } from "../../types/analysis";

function severityFromWeight(w: number): any {
  if (w >= 25) return "high";
  if (w >= 15) return "medium";
  return "low";
}

export function buildEvidenceTop3(hits: any): EvidenceItem[] {
  const arr: any[] = Array.isArray(hits) ? hits : [];

  return arr.slice(0, 3).map((h): EvidenceItem => {
    const label = String(h?.label ?? h?.ruleId ?? "").trim() || "signal";

    const matchedArr: any[] = Array.isArray(h?.matched)
      ? h.matched
      : Array.isArray(h?.matchedTexts)
        ? h.matchedTexts
        : Array.isArray(h?.matches)
          ? h.matches
          : [];

    const matched = matchedArr
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(", ");

    const sample = String(h?.sample ?? h?.snippet ?? "").trim();

    const parts: string[] = [label];
    if (matched) parts.push(matched);
    if (sample) parts.push(`"${sample}"`);

    const weight = Number(h?.weight);
    const severity = Number.isFinite(weight) ? severityFromWeight(weight) : "medium";

    // EvidenceItem에 kind/severity가 필수라 기본값을 넣고,
    // 실제 union literal이 다를 수 있으니 런타임 안전 + TS는 단언으로 통과시킴
    const kind = String(h?.kind ?? "hit");

    return ({ kind, severity, text: parts.join(" · ") } as unknown) as EvidenceItem;
  });
}
