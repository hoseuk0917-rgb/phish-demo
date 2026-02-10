// @ts-nocheck
import fs from "node:fs";
import { analyzeThread } from "../src/engine";

async function main() {
  const id = process.argv[2] ?? "SC00002";
  const path = process.argv[3] ?? "datasets/ko_scam/scenarios_ko_v3_smoke.jsonl";

  const line = fs.readFileSync(path, "utf8")
    .split(/\r?\n/)
    .find(l => l.includes(`"id":"${id}"`));

  if (!line) throw new Error(`not found: ${id}`);

  const c = JSON.parse(line);
  const text = String(c.thread ?? c.rawThread ?? c.text ?? "");

  const r = await analyzeThread({
    threadText: text,
    callChecks: {
      otpAsked: false,
      remoteAsked: false,
      urgentPressured: false,
      firstContact: false,
      ...(c.callChecks ?? {}),
    },
  } as any);

  console.log(JSON.stringify({
    id,
    expected: c.expected,
    got: { risk: r.riskLevel, score: r.scoreTotal, stagePeak: r.stagePeak },
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
