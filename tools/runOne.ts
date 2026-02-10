import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { analyzeThread } from "../src/engine/index";
import type { AnalysisInput, AnalysisResult, StageId } from "../src/types/analysis";
import { applySimilarityFromSignals } from "../src/engine/similarity/applySimilarity";

type SimIndexFile = { items?: any[] };

const STAGE_RANK: Record<StageId, number> = { info: 0, verify: 1, install: 2, payment: 3 };

function parseArgs(argv: string[]) {
  const out = {
    path: "datasets/ko_scam/scenarios_ko_v1.jsonl",
    id: "",
    simIndex: "public/simindex_ko_v2.json",
    simTopK: 10,
    simMin: 0.9, // gate (boost만)
  };

  const get = (k: string) => {
    const i = argv.findIndex((x) => x === k);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
  };

  const p = get("--path");
  if (p) out.path = p;

  const id = get("--id");
  if (id) out.id = id;

  const si = get("--sim-index");
  if (si) out.simIndex = si;

  const k = get("--sim-topk");
  if (k && Number.isFinite(Number(k))) out.simTopK = Math.max(1, Number(k));

  // ✅ alias: --sim-gate == --sim-min
  const gate = get("--sim-gate") || get("--sim-min");
  if (gate && Number.isFinite(Number(gate))) {
    out.simMin = Math.max(0, Math.min(1, Number(gate)));
  }

  return out;
}

function readJsonl(filePath: string): any[] {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n");
  const rows: any[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch { }
  }
  return rows;
}

function loadSimIndexItems(simIndexPath: string): any[] {
  const abs = path.isAbsolute(simIndexPath) ? simIndexPath : path.join(process.cwd(), simIndexPath);
  const txt = fs.readFileSync(abs, "utf-8");
  const json = JSON.parse(txt) as SimIndexFile;
  return Array.isArray(json?.items) ? json.items : [];
}

function stagePeakFromResult(r: AnalysisResult): StageId {
  const rr: any = r as any;
  let best: StageId = "info";
  const ms = Array.isArray(rr.messageSummaries) ? rr.messageSummaries : [];
  for (const m of ms) {
    const s = m?.stage as StageId;
    if (s && STAGE_RANK[s] > STAGE_RANK[best]) best = s;
  }
  if (best !== "info") return best;
  const tl = Array.isArray(rr.stageTimeline) ? rr.stageTimeline : [];
  for (const e of tl) {
    const s = e?.stage as StageId;
    if (s && STAGE_RANK[s] > STAGE_RANK[best]) best = s;
  }
  return best;
}

function pickTop(arr: any[], n: number) {
  return (Array.isArray(arr) ? arr : []).slice(0, n);
}

function fmtSimTop(arr: any[]) {
  const top = pickTop(arr, 3).map((x: any) => {
    const id = String(x?.id ?? "");
    const cat = String(x?.category ?? "");
    const sim = Number(x?.similarity ?? 0).toFixed(3);
    const shared = Array.isArray(x?.sharedSignals) ? x.sharedSignals.slice(0, 5).join("|") : "";
    return `${id} [${cat}] sim=${sim}${shared ? ` shared=${shared}` : ""}`;
  });
  return top.length ? top.join(" ; ") : "(none)";
}

function printRes(tag: string, r: AnalysisResult) {
  const rr: any = r as any;

  console.log("");
  console.log(`== ${tag} ==`);
  console.log(`risk=${rr.riskLevel} score=${rr.scoreTotal} stagePeak=${stagePeakFromResult(r)}`);

  const hits = pickTop(rr.hitsTop, 8).map((h: any) => `${h?.ruleId ?? "?"}(+${h?.weight ?? 0})`);
  const sigs = pickTop(rr.signalsTop, 8).map((s: any) => `${s?.id ?? "?"}(sum=${s?.weightSum ?? 0})`);

  console.log(`hitsTop:    ${hits.join(", ")}`);
  console.log(`signalsTop: ${sigs.join(", ")}`);
  console.log(`similarityTop: ${fmtSimTop(rr.similarityTop)}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    console.error("missing --id (e.g. --id KO-0008)");
    process.exit(1);
  }

  const rows = readJsonl(args.path);
  const row = rows.find((x) => String(x?.id || "") === args.id);
  if (!row) {
    console.error(`id not found: ${args.id}`);
    process.exit(1);
  }

  const input: AnalysisInput = {
    threadText: String(row.thread ?? ""),
    callChecks: {
      otpAsked: false,
      remoteAsked: false,
      urgentPressured: false,
      firstContact: false,
      ...(row.callChecks ?? {}),
    },
  };

  const simItems = loadSimIndexItems(args.simIndex);

  const base = analyzeThread(input);
  printRes("BASE (no simIndexItems)", base);

  // ✅ PROBE: analyzeThread 밖에서 직접 similarity를 돌려서 “매칭 자체가 되는지” 확인
  const baseAny: any = base as any;
  const probeSignals = Array.isArray(baseAny?.signalsTop) ? baseAny.signalsTop : [];
  const probe = applySimilarityFromSignals(probeSignals as any, simItems as any, {
    topK: args.simTopK,
    minSim: 0, // 일단 0으로 깔고 “최고 sim”이 얼마인지 확인
  });
  console.log("");
  console.log(`== PROBE similarity (signalsTop -> simIndex, min=0, topK=${args.simTopK}, items=${simItems.length}) ==`);
  console.log(`probeTop: ${fmtSimTop(probe as any[])}`);

  const withSim = analyzeThread(input, {
    simIndexItems: simItems as any,
    simTopK: args.simTopK,
    simMinSim: args.simMin,
  });
  printRes(`SIM (min=${args.simMin}, topK=${args.simTopK}, items=${simItems.length})`, withSim);
}

main();
