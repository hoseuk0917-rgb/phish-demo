import type { ActionItem, EvidenceItem, RiskLevel, SignalSummary } from "../../types/analysis";

export function buildPackageText(args: {
  riskLevel: RiskLevel;
  scoreTotal: number;
  messageCount: number;
  evidenceTop3: EvidenceItem[];
  signalsTop: SignalSummary[];
  actions: ActionItem[];
}) {
  const lines: string[] = [];

  lines.push(`[피싱 의심 분석 패키지]`);
  lines.push(`- 위험도: ${args.riskLevel.toUpperCase()} (${args.scoreTotal}/100)`);
  lines.push(`- 메시지 블록 수: ${args.messageCount}`);
  lines.push("");

  lines.push(`[핵심 증거 Top3]`);
  args.evidenceTop3.forEach((e, i) => lines.push(`${i + 1}. ${e.text}`));
  lines.push("");

  lines.push(`[상세 신호(요약)]`);
  args.signalsTop.forEach((s: any) => {
    const wRaw = s?.weightSum ?? s?.weight ?? 0;
    const w = Number.isFinite(Number(wRaw)) ? Number(wRaw) : 0;

    const cRaw = s?.count;
    const c =
      Number.isFinite(Number(cRaw))
        ? Number(cRaw)
        : Array.isArray(s?.matched)
          ? s.matched.length
          : Array.isArray(s?.hits)
            ? s.hits.length
            : w > 0
              ? 1
              : 0;

    const label = String(s?.label ?? s?.id ?? "").trim();
    if (!label) return;

    lines.push(`- ${label} (+${w}, ${c} hits)`);
  });
  lines.push("");

  lines.push(`[권장 행동]`);
  args.actions.forEach((a) => lines.push(`- ${a.label}`));

  return lines.join("\n");
}
