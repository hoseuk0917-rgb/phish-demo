import fs from "node:fs";
import path from "node:path";
import { analyzeThread } from "../src/engine/index";

type Risk = "low" | "medium" | "high";

const argv = process.argv.slice(2);
const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
};
const has = (k: string) => argv.includes(k);

const IN = get("--in");
const OUT = get("--out") || "datasets/ko_scam/mutated/_showcase_candidate.jsonl";
const LIMIT = Number(get("--limit") || "30");

const preferUi = has("--prefer-ui");
const preferThreat = has("--prefer-threat");
const targetRisk = (get("--risk") as Risk) || "low"; // low | medium | high

if (!IN) {
    console.error("Usage: npx tsx tools/_exportCandidateShowcase.ts --in <in.jsonl> --out <out.jsonl> [--prefer-ui|--prefer-threat] [--risk low|medium] [--limit 30]");
    process.exit(2);
}

function normRisk(x: any): Risk | "" {
    const s = String(x ?? "").toLowerCase().trim();
    return s === "low" || s === "medium" || s === "high" ? (s as Risk) : "";
}

const STAGE_RANK: Record<string, number> = { info: 0, verify: 1, install: 2, payment: 3 };
function stagePeakFromRes(res: any): string {
    let best = "info";
    const take = (s: any) => {
        const k = String(s ?? "").toLowerCase().trim();
        if (k in STAGE_RANK && STAGE_RANK[k] > STAGE_RANK[best]) best = k;
    };
    for (const m of (Array.isArray(res?.messageSummaries) ? res.messageSummaries : [])) take(m?.stage);
    for (const e of (Array.isArray(res?.stageTimeline) ? res.stageTimeline : [])) take(e?.stage);
    for (const h of (Array.isArray(res?.hitsTop) ? res.hitsTop : [])) take(h?.stage);
    return best;
}

function pickRisk(res: any): Risk {
    const threat = normRisk(res?.riskLevel) || "low";
    const ui = normRisk(res?.uiRiskLevel) || threat;
    if (preferThreat) return threat;
    if (preferUi) return ui;
    // 기본은 UI 우선(네 runDataset 현재 로직과 맞추기 쉬움)
    return ui;
}

function isCandidate(res: any): boolean {
    const hits = Array.isArray(res?.hitsTop) ? res.hitsTop : [];
    if (!hits.length) return false;

    const stage = stagePeakFromRes(res);
    if ((STAGE_RANK[stage] ?? 0) >= STAGE_RANK.verify) return true;

    // stage가 info여도, action성 ruleId나 힌트가 있으면 후보로 올리고 싶으면 여기서 확장 가능
    return false;
}

const rows = fs.readFileSync(IN, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
const picked: any[] = [];

for (const row of rows) {
    const thread = String(row.thread ?? row.threadText ?? "");
    const res = await analyzeThread({
        threadText: thread,
        callChecks: { otpAsked: false, remoteAsked: false, urgentPressured: false, firstContact: false, ...(row.callChecks ?? {}) }
    } as any);

    const r = pickRisk(res);
    const cand = isCandidate(res);

    if (r === targetRisk && cand) {
        picked.push({
            id: row.id,
            label: row.label,
            thread,
            callChecks: row.callChecks,
            meta_showcase: {
                pickedRisk: r,
                stagePeak: stagePeakFromRes(res),
                scoreTotal: Number(res?.scoreTotal ?? 0),
                uiRiskLevel: String(res?.uiRiskLevel ?? ""),
                threatRiskLevel: String(res?.riskLevel ?? ""),
                hitsTopLen: Array.isArray(res?.hitsTop) ? res.hitsTop.length : 0,
            }
        });
        if (picked.length >= LIMIT) break;
    }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, picked.map(x => JSON.stringify(x)).join("\n") + "\n", "utf8");
console.log("OK showcase:", OUT, "picked", picked.length, "from", rows.length);
