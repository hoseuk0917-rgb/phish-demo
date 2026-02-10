import fs from "fs";
import readline from "readline";
import { analyzeThread } from "../src/engine";

const inPath = process.argv[2];
const outPath = process.argv[3];

if (!inPath || !outPath) {
  console.error("usage: npx tsx tmp/relabel_risk_to_engine.ts <in.jsonl> <out.jsonl>");
  process.exit(1);
}

const rs = fs.createReadStream(inPath, { encoding: "utf8" });
const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
const ws = fs.createWriteStream(outPath, { encoding: "utf8" });

let n = 0;
let changed = 0;

const distIn: Record<string, number> = {};
const distOut: Record<string, number> = {};

for await (const line of rl) {
  const l = String(line || "").trim();
  if (!l) continue;

  n++;
  const row: any = JSON.parse(l);

  const threadText =
    typeof row.threadText === "string" ? row.threadText :
    typeof row.thread === "string" ? row.thread :
    Array.isArray(row.threadBlocks) ? row.threadBlocks.map((x: any) => String(x ?? "")).join("\n") :
    "";

  const expected = row.expected ?? {};
  const prevRisk = String(expected.riskLevel ?? row.label ?? "").trim();

  distIn[prevRisk || ""] = (distIn[prevRisk || ""] ?? 0) + 1;

  const res: any = analyzeThread({ threadText } as any);
  const newRisk = String(res?.riskLevel ?? "").trim();

  distOut[newRisk || ""] = (distOut[newRisk || ""] ?? 0) + 1;

  if (newRisk && prevRisk !== newRisk) {
    changed++;
    row.label = newRisk;
    row.expected = { ...expected, riskLevel: newRisk };
  }

  // 추적용(선택): 언제/무슨 기준으로 바뀌었는지
  row.meta_relabel = {
    at: new Date().toISOString(),
    engineRisk: newRisk,
    engineScore: Number(res?.scoreTotal ?? 0),
    engineStagePeak: String(res?.stagePeak ?? ""),
  };

  ws.write(JSON.stringify(row) + "\n");
}

ws.end();

console.log(JSON.stringify({ n, changed, distIn, distOut }, null, 2));
