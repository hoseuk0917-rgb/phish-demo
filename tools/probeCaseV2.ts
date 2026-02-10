import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";
import type { AnalysisInput, StageId } from "../src/types/analysis";

const ord: Record<StageId, number> = { info: 0, verify: 1, install: 2, payment: 3 };

function maxStage(list: Array<StageId | undefined>): StageId {
  let peak: StageId = "info";
  for (const s of list) {
    if (!s) continue;
    if (ord[s] > ord[peak]) peak = s;
  }
  return peak;
}

async function main() {
  const id = process.argv[2] ?? "SC00002";
  const p = process.argv[3] ?? "datasets/ko_scam/scenarios_ko_v3_smoke.jsonl";

  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const line = lines.find((l) => l.includes("\"id\":\"" + id + "\""));
  if (!line) throw new Error("not found: " + id);

  const row = JSON.parse(line);

  const threadText = String(row.threadText ?? row.thread ?? row.rawThread ?? row.text ?? "");
  const callChecks = {
    otpAsked: false,
    remoteAsked: false,
    urgentPressured: false,
    firstContact: false,
    ...(row.callChecks ?? row.call ?? {}),
  };

  const input: AnalysisInput = { threadText, callChecks };
  const r = analyzeThread(input);

  const stageByHits = maxStage((r.hitsTop ?? []).map((h) => h.stage));
  const stageByTimeline = maxStage((r.stageTimeline ?? []).map((e) => e.stage));
  const stageByMsgs = maxStage((r.messageSummaries ?? []).map((m) => m.stage));

  console.log(
    JSON.stringify(
      {
        id,
        expected: row.expected,
        got: { riskLevel: r.riskLevel, scoreTotal: r.scoreTotal },
        stagePeak: { byHitsTop: stageByHits, byTimeline: stageByTimeline, byMessageSummaries: stageByMsgs },
        topHits: (r.hitsTop ?? []).slice(0, 30),
        topSignals: (r.signalsTop ?? []).slice(0, 12),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
