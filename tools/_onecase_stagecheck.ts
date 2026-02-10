import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const DATA = "datasets/ko_scam/mutated/out_nonlow_fast.jsonl";
const ID = "MUT-SC00004-0001";

const STAGE_RANK: Record<string, number> = {
  none: -1,
  info: 0,
  verify: 1,
  payment: 2,
  install: 3,
};

function norm(s: any): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function inferStageFromHits(res: any): string {
  const hits: any[] = Array.isArray(res?.hitsTop) ? res.hitsTop : [];
  let best = "none";
  let bestR = -1;

  for (const h of hits) {
    let s = norm(h?.stage);
    if (s === "transfer") s = "payment";
    if (s === "pay") s = "payment";

    const r = STAGE_RANK[s] ?? -1;
    if (r > bestR) {
      bestR = r;
      best = s;
    }
  }
  return best;
}

const line = fs
  .readFileSync(DATA, "utf8")
  .split(/\r?\n/)
  .find((l) => l.includes(ID));

if (!line) throw new Error("not found");

const row: any = JSON.parse(line);
const thread = String(row.thread ?? "");

const input = {
  threadText: thread,
  callChecks: {
    otpAsked: false,
    remoteAsked: false,
    urgentPressured: false,
    firstContact: false,
    ...(row.callChecks ?? {}),
  },
};

const res = await analyzeThread(input as any);

const out = {
  scoreTotal: (res as any)?.scoreTotal,
  risk: (res as any)?.riskLevel,
  triggered: Boolean((res as any)?.triggered),
  stage: inferStageFromHits(res),
};
console.log(out);

console.log(
  "hitsTop:",
  ((res as any)?.hitsTop ?? []).slice(0, 10).map((h: any) => ({
    ruleId: h.ruleId,
    stage: h.stage,
    w: h.weight,
  }))
);
