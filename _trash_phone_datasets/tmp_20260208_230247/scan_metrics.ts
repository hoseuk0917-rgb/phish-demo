import fs from "node:fs";
import { analyzeThread } from "../src/engine";

const ds = process.argv[2];
const limit = Math.max(1, Number(process.argv[3] || "40"));
if (!ds) {
  console.error("Usage: npx tsx .\\tmp\\scan_metrics.ts <dataset.jsonl> [limit]");
  process.exit(2);
}

const rows = fs.readFileSync(ds, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
const pickId = (r:any) => String(r.id ?? r.case_id ?? r.caseId ?? r.name ?? "");
const pickThread = (r:any) => {
  const t = r.thread ?? r.threadText ?? r.rawThread ?? r.rawThreadText ?? r.text ?? r.input ?? "";
  return Array.isArray(t) ? t.join("\n") : String(t ?? "");
};

const dist = new Map<string, number>();
const scoreBuckets = new Map<string, number>();
const hiNoReason: any[] = [];

const bucketOf = (s:number) => {
  if (s >= 90) return "90-100";
  if (s >= 65) return "65-89";
  if (s >= 35) return "35-64";
  return "0-34";
};

for (let i=0; i<Math.min(limit, rows.length); i++) {
  const row = rows[i];
  const id = pickId(row);
  const threadText = pickThread(row);
  const callChecks = !!row.callChecks;

  const res:any = await analyzeThread({ threadText, callChecks } as any);

  const scoreTotal = Number(res.uiScoreTotal ?? res.scoreTotal ?? 0);
  const riskLevel = String(res.riskLevel ?? "n/a");
  const uiRiskLevel = String(res.uiRiskLevel ?? "n/a");
  const stagePeak = String(res.stagePeak ?? res.stage ?? "n/a");

  const key = `${riskLevel}|${uiRiskLevel}|${stagePeak}`;
  dist.set(key, (dist.get(key) || 0) + 1);

  const b = bucketOf(scoreTotal);
  scoreBuckets.set(b, (scoreBuckets.get(b) || 0) + 1);

  const sigs:any[] = Array.isArray(res.signalsTop) ? res.signalsTop : [];
  const reasonLabels = Array.from(new Set(sigs.map(s => String(s?.label ?? s?.id ?? "").trim()).filter(Boolean)));

  if (String(riskLevel).toLowerCase() === "high" && reasonLabels.length === 0) {
    hiNoReason.push({ id, scoreTotal, stagePeak, riskLevel, uiRiskLevel });
  }
}

const sortedDist = Array.from(dist.entries()).sort((a,b)=>b[1]-a[1]);
console.log("== dist (THREAT|UI|stage) ==");
for (const [k,v] of sortedDist.slice(0, 20)) console.log(v, k);

console.log("\n== score buckets ==");
for (const k of ["90-100","65-89","35-64","0-34"]) console.log(k, scoreBuckets.get(k) || 0);

if (hiNoReason.length) {
  console.log("\n== high but no reasons (signalsTop empty) ==");
  for (const x of hiNoReason.slice(0, 10)) console.log(x);
} else {
  console.log("\n== high but no reasons: none ==");
}
