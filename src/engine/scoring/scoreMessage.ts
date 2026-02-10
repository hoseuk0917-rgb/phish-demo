import type { Rule } from "../rules/keywords";

export type Hit = {
  ruleId: string;
  label: string;
  stage: "info" | "verify" | "install" | "payment";
  weight: number;
  matched: string[];
  sample: string;
};

export function scoreMessage(text: string, rules: Rule[]): Hit[] {
  const hits: Hit[] = [];
  const t = text || "";

  for (const r of rules) {
    let allMatches: string[] = [];
    for (const re of r.patterns) {
      const m = t.match(re);
      if (m && m.length) allMatches = allMatches.concat(m);
    }
    if (allMatches.length > 0) {
      const uniq = Array.from(new Set(allMatches.map((x) => x.trim()).filter(Boolean))).slice(0, 6);
      hits.push({
        ruleId: r.id,
        label: r.label,
        stage: r.stage,
        weight: r.weight * Math.min(3, uniq.length),
        matched: uniq,
        sample: t.length > 140 ? t.slice(0, 140) + "…" : t,
      });
    }
  }

  return hits;
}
