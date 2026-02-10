import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const IN = "datasets/ko_scam/mutated/out_nonlow_fast.jsonl";
const OUT = "datasets/ko_scam/mutated/out_nonlow_fast_expected_ui.jsonl";

function normRisk(x: any): "low" | "medium" | "high" | "" {
  const s = String(x ?? "").toLowerCase().trim();
  if (s === "low" || s === "medium" || s === "high") return s;
  return "";
}

// UI 라벨에 맞춰 score_min도 같이 정리
function scoreMinForUi(ui: "low" | "medium" | "high"): number | null {
  if (ui === "high") return 60;
  if (ui === "medium") return 30;
  return null; // low면 강제조건 제거
}

const rows = fs
  .readFileSync(IN, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const out: string[] = [];

for (const row of rows) {
  const thread = String(row.thread ?? row.threadText ?? "");
  const res = await analyzeThread({
    threadText: thread,
    callChecks: {
      otpAsked: false,
      remoteAsked: false,
      urgentPressured: false,
      firstContact: false,
      ...(row.callChecks ?? {}),
    },
  } as any);

  const threat = normRisk((res as any).riskLevel) || "low";
  const ui = normRisk((res as any).uiRiskLevel) || threat;

  row.meta = row.meta ?? {};
  row.meta.expected_prev = row.expected ? { ...row.expected } : null;

  // score_min 이전값도 메타에 남겨두면 디버그 쉬움
  const prevMin = row?.expected?.score_min;
  if (prevMin != null) row.meta.score_min_prev = prevMin;

  row.expected = row.expected ?? {};

  // threat/ui 둘 다 보관
  (row.expected as any).threatRiskLevel = threat;
  (row.expected as any).uiRiskLevel = ui;

  // runDataset 비교용 대표 riskLevel은 UI 기준으로 둠
  row.expected.riskLevel = ui;

  // score_min을 UI 기준으로 맞춤
  const nextMin = scoreMinForUi(ui);
  if (nextMin == null) {
    delete row.expected.score_min;
  } else {
    row.expected.score_min = nextMin;
  }

  out.push(JSON.stringify(row));
}

fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
console.log("OK:", OUT, "rows", out.length);
