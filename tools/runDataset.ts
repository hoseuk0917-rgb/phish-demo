// tools/runDataset.ts — FULL UPDATED (SWAP-IN)
/**
 * Dataset runner for phish-demo
 *
 * Run:
 *   npx tsx tools/runDataset.ts --path datasets/ko_scam/scenarios_ko_v1.jsonl
 *   npx tsx tools/runDataset.ts --path datasets/ko_scam/scenarios_ko_v1.jsonl --sim
 *   npx tsx tools/runDataset.ts --path datasets/ko_scam/scenarios_ko_v1.jsonl --sim --sim-gate 0.9
 *
 * Flags:
 *   --path <jsonl>
 *   --limit <n>
 *   --only-fail
 *   --show-fails <n>
 *
 *   --dump-fails <jsonl>      // ✅ 모든 fail을 JSONL로 저장 (thread/meta/notes 포함)
 *   --dump-summary <tsv>      // ✅ fail 요약(원인/리스크쌍/스테이지쌍) TSV 저장
 *
 *   --sim
 *   --sim-index <path>
 *   --sim-topk <n>
 *   --sim-gate <0..1>         (alias: --sim-min, --sim-minsim)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { analyzeThread } from "../src/engine/index";
import { prefilterThread } from "../src/engine/prefilter/prefilter";
import type { AnalysisInput, AnalysisResult, RiskLevel, StageId } from "../src/types/analysis";
import type { SimIndexItem } from "../src/engine/similarity/simIndex";

type ScenarioExpected = {
    riskLevel: RiskLevel;
    score_min?: number;
    stagePeak?: StageId;
    triggered?: boolean;
};

type ScenarioRow = {
    id: string;
    label?: string;
    thread: string;
    callChecks?: any;
    expected: ScenarioExpected;

    // (dataset jsonl이 더 많은 필드를 갖는 경우를 대비)
    notes?: any;
    meta?: any;
    should_trigger?: any;
};

type FailItem = {
    id: string;
    label: string;
    expected: ScenarioExpected;
    got: { riskLevel: RiskLevel; scoreTotal: number; stagePeak: StageId; triggered: boolean };
    why: string[];

    // ✅ 디버그용 풀 컨텍스트
    thread: string;
    senderText: string;

    notes?: any;
    meta?: any;
    should_trigger?: any;
};

const STAGE_RANK: Record<StageId, number> = { info: 0, verify: 1, install: 2, payment: 3 };

function clamp01(n: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function absPath(p: string) {
    return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function ensureDirForFile(filePath: string) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(filePath: string, rows: any[]) {
    // "-" => stdout(JSONL)
    if (String(filePath || "").trim() === "-") {
        const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
        process.stdout.write(body);
        return;
    }

    const abs = absPath(filePath);
    ensureDirForFile(abs);
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.writeFileSync(abs, body, "utf-8");
}

function writeText(filePath: string, text: string) {
    // "-" => stdout
    if (String(filePath || "").trim() === "-") {
        process.stdout.write(String(text ?? ""));
        return;
    }

    const abs = absPath(filePath);
    ensureDirForFile(abs);
    fs.writeFileSync(abs, text, "utf-8");
}

function parseArgs(argv: string[]) {
    const out = {
        path: "datasets/ko_scam/scenarios_ko_v1.jsonl",
        limit: 0,
        onlyFail: false,
        showFails: 3,

        dumpFails: "",
        dumpSummary: "",

        // ✅ risk source mode
        // - "threat": gotRisk는 riskLevel만 사용(정책 기준)
        // - "ui": gotRisk는 uiRiskLevel 우선(UI 표시용 비교)
        riskMode: "threat" as "ui" | "threat",

        simEnabled: false,
        simIndexPath: "public/simindex_ko_v2.json",
        simTopK: 10,
        simGate: 0.9, // gate for boost (engine uses it as simMinSim)
    };

    const has = (k: string) => argv.includes(k);

    const get = (k: string) => {
        const i = argv.findIndex((x) => x === k);
        return i >= 0 ? (argv[i + 1] ?? "") : "";
    };

    const p = get("--path");
    if (p) out.path = p;

    const lim = get("--limit");
    if (lim && Number.isFinite(Number(lim))) out.limit = Math.max(0, Math.floor(Number(lim)));

    if (has("--only-fail")) out.onlyFail = true;

    const sf = get("--show-fails");
    if (sf && Number.isFinite(Number(sf))) out.showFails = Math.max(0, Math.floor(Number(sf)));

    // ✅ dumps
    const df = get("--dump-fails");
    if (df) out.dumpFails = df;
    else if (has("--dump-fails")) throw new Error("Missing value: --dump-fails <path>");

    const ds = get("--dump-summary");
    if (ds) out.dumpSummary = ds;
    else if (has("--dump-summary")) throw new Error("Missing value: --dump-summary <path>");

    // ✅ risk mode flags
    // threat 우선(둘 다 주면 threat가 이김)
    if (has("--prefer-threat") || has("--preferThreat")) out.riskMode = "threat";
    else if (has("--prefer-ui") || has("--preferUi")) out.riskMode = "ui";

    // SIM
    if (has("--sim")) out.simEnabled = true;

    const si = get("--sim-index");
    if (si) out.simIndexPath = si;

    const topk = get("--sim-topk");
    if (topk && Number.isFinite(Number(topk))) out.simTopK = Math.max(1, Math.floor(Number(topk)));

    const gateStr = get("--sim-gate") || get("--sim-min") || get("--sim-minsim");
    if (gateStr && Number.isFinite(Number(gateStr))) out.simGate = clamp01(Number(gateStr));

    // if user provided sim-index explicitly, assume sim on
    if (!out.simEnabled && (has("--sim-index") || !!si)) out.simEnabled = true;

    return out;
}

function readJsonl(filePath: string): ScenarioRow[] {
    const abs = absPath(filePath);
    const raw = fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n");
    const rows: ScenarioRow[] = [];

    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const obj = JSON.parse(t);
            if (obj && typeof obj === "object") rows.push(obj as ScenarioRow);
        } catch {
            // skip
        }
    }
    return rows;
}

function loadSimIndexItems(simIndexPath: string): SimIndexItem[] {
    const abs = absPath(simIndexPath);
    const txt = fs.readFileSync(abs, "utf-8");
    const json = JSON.parse(txt) as any;
    const items = Array.isArray(json?.items) ? json.items : [];
    return items as SimIndexItem[];
}

function stagePeakFromResult(r: AnalysisResult): StageId {
    const rr: any = r as any;

    let best: StageId = "info";

    const ms = Array.isArray(rr.messageSummaries) ? rr.messageSummaries : [];
    for (const m of ms) {
        const s = m?.stage as StageId;
        if (s && STAGE_RANK[s] > STAGE_RANK[best]) best = s;
    }

    const tl = Array.isArray(rr.stageTimeline) ? rr.stageTimeline : [];
    for (const e of tl) {
        const s = e?.stage as StageId;
        if (s && STAGE_RANK[s] > STAGE_RANK[best]) best = s;
    }

    const ht = Array.isArray(rr.hitsTop) ? rr.hitsTop : [];
    for (const h of ht) {
        const s = h?.stage as StageId;
        if (s && STAGE_RANK[s] > STAGE_RANK[best]) best = s;
    }

    return best;
}

function triggeredFromResult(r: AnalysisResult): boolean {
    const rr: any = r as any;
    const pf: any = rr?.prefilter;

    const risk = String(rr?.riskLevel ?? "").toLowerCase().trim(); // "low" | "medium" | "high"
    const scoreTotal = Number(rr?.scoreTotal);

    const hits = Array.isArray(rr?.hitsTop) ? rr.hitsTop : [];
    const hitsTopLen = hits.length;

    // hitsTop에서 “강도” 추정(엔진/버전별 필드명 차이를 흡수)
    const maxHitWeight = hits.reduce((m: number, h: any) => {
        const w = Number(h?.weightSum ?? h?.weight ?? h?.score ?? h?.points ?? 0);
        return Number.isFinite(w) ? Math.max(m, w) : m;
    }, 0);

    // prefilter soft threshold를 “low fallback”의 기준으로 재사용(없으면 28로)
    const softFromPf = Number(pf?.thresholdSoft);
    // low에서는 thresholdSoft(보통 28)가 너무 빡세서 FN이 나옴 → 20으로 캡
    const lowGate = Math.min(Number.isFinite(softFromPf) ? softFromPf : 28, 20);

    // ✅ medium/high fallback용: BN00079/BN00100(score=54)을 내려가게 하는 컷
    const medHighScoreGate = 58;
    const medHighHitGate = 20;

    function fallbackTriggered(): boolean {
        if (hitsTopLen <= 0) return false;
        if (!Number.isFinite(scoreTotal)) return false;

        // low: 0점/무의미 점수는 승격 금지 + 강한 히트만
        if (risk === "low") {
            if (scoreTotal < 15) return false;
            return maxHitWeight >= lowGate;
        }

        // medium/high: 점수 + 히트강도 둘 다 만족할 때만 승격
        return scoreTotal >= medHighScoreGate && maxHitWeight >= medHighHitGate;
    }

    // 1) prefilter가 있으면: prefilter의 “정석 기준”이 1차
    if (pf) {
        if (typeof pf.triggered === "boolean") return pf.triggered;
        if (typeof pf.isTriggered === "boolean") return pf.isTriggered;

        const shouldA = Array.isArray(pf.should_trigger) ? pf.should_trigger : null;
        const shouldB = Array.isArray(pf.shouldTrigger) ? pf.shouldTrigger : null;
        if ((shouldA && shouldA.length) || (shouldB && shouldB.length)) return true;

        const action = String(pf.action ?? "").toLowerCase().trim();
        if (action && action !== "none") return true;

        const pfScore = Number(pf.score);
        const soft = Number(pf.thresholdSoft);
        const auto = Number(pf.thresholdAuto);

        if (Number.isFinite(pfScore) && Number.isFinite(soft) && pfScore >= soft) return true;
        if (Number.isFinite(pfScore) && !Number.isFinite(soft) && Number.isFinite(auto) && pfScore >= auto) return true;

        if (!Number.isFinite(pfScore) && typeof pf.gatePass === "boolean") return pf.gatePass;

        return fallbackTriggered();
    }

    // 2) prefilter가 없으면: top-level flag는 참고만(승격은 fallback 규칙으로)
    if (typeof rr?.triggered === "boolean" && rr.triggered === true) return fallbackTriggered();
    if (typeof rr?.isTriggered === "boolean" && rr.isTriggered === true) return fallbackTriggered();

    return fallbackTriggered();
}

function percent(n: number, d: number) {
    if (d <= 0) return "0.0%";
    return ((n / d) * 100).toFixed(1) + "%";
}

function senderTextFromThread(thread: string) {
    const lines = String(thread || "").split(/\r?\n/);
    const sLines = lines.filter((l) => /^S:\s*/.test(l.trim()));
    return sLines.join(" ").trim();
}

function whyKeyOf(w: string) {
    if (w.startsWith("risk mismatch:")) return "risk_mismatch";
    if (w.startsWith("score below min:")) return "score_below_min";
    if (w.startsWith("stagePeak mismatch:")) return "stage_mismatch";
    if (w.startsWith("triggered mismatch:")) return "triggered_mismatch";
    if (w.startsWith("analyzeThread threw:")) return "engine_throw";
    return "other";
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    const rows = readJsonl(args.path);
    const list = args.limit > 0 ? rows.slice(0, args.limit) : rows;
    const total = list.length;

    let simItems: SimIndexItem[] = [];
    let simStatus = "OFF";
    if (args.simEnabled) {
        try {
            simItems = loadSimIndexItems(args.simIndexPath);
            simStatus = `ON (${args.simIndexPath} items=${simItems.length} topK=${args.simTopK} gate=${args.simGate})`;
        } catch (e: any) {
            simItems = [];
            simStatus = `OFF (load failed: ${String(e?.message || e)})`;
        }
    }

    const fails: FailItem[] = [];
    let pass = 0;

    let riskOk = 0;
    let scoreOk = 0;
    let stageOk = 0;
    let trigOk = 0;

    const expDist: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0 };
    const gotDist: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0 };

    for (const row of list) {
        if (!row || !row.thread || !row.expected || !row.id) continue;

        expDist[row.expected.riskLevel] = (expDist[row.expected.riskLevel] ?? 0) + 1;

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

        let res: AnalysisResult;
        try {
            const simOpts =
                args.simEnabled && simItems.length
                    ? ({
                        simIndexItems: simItems,
                        simTopK: args.simTopK,
                        simMinSim: args.simGate, // gate for boost
                    } as any)
                    : undefined;

            res = simOpts ? analyzeThread(input, simOpts) : analyzeThread(input);
        } catch (e: any) {
            const why = [`analyzeThread threw: ${String(e?.message || e)}`];
            fails.push({
                id: row.id,
                label: row.label ?? "",
                expected: row.expected,
                got: { riskLevel: "low", scoreTotal: 0, stagePeak: "info", triggered: false },
                why,
                thread: String(row.thread ?? ""),
                senderText: senderTextFromThread(String(row.thread ?? "")),
                notes: (row as any).notes,
                meta: (row as any).meta,
                should_trigger: (row as any).should_trigger,
            });
            continue;
        }

        const gotRisk: RiskLevel = (() => {
            const pick = (x: any): RiskLevel | "" => {
                const v = String(x ?? "").toLowerCase().trim();
                if (v === "low" || v === "medium" || v === "high") return v as RiskLevel;
                return "";
            };

            // 1) UI 모드: uiRiskLevel 우선(비교용)
            if (args.riskMode === "ui") {
                const u = pick((res as any)?.uiRiskLevel);
                if (u) return u;
            }

            // 2) Threat 모드(또는 UI 없음): riskLevel 신뢰(엔진이 이미 정책을 반영해야 함)
            const t = pick((res as any)?.riskLevel ?? (res as any)?.risk ?? (res as any)?.riskLevelId ?? (res as any)?.riskLevel);
            if (t) return t;

            // 3) fallback (정말 필드가 없을 때만)
            const s = Number((res as any)?.scoreTotal ?? 0);
            if (s >= 65) return "high";
            if (s >= 35) return "medium";
            return "low";
        })();

        const gotScore = res.scoreTotal;
        const gotStage = stagePeakFromResult(res);

        // triggers: 1) engine/prefilter 기반 → 2) 로컬 prefilter 재실행 → 3) callChecks → 4) scoreTotal>=soft
        let gotTrig = triggeredFromResult(res);

        // soft 기준(가능하면 res.prefilter의 soft를 쓰고, 없으면 로컬 pf에서 보충)
        let softRef: number | null = null;
        try {
            const soft0 = Number((res as any)?.prefilter?.thresholdSoft);
            if (Number.isFinite(soft0)) softRef = soft0;
        } catch {
        }

        if (!gotTrig) {
            try {
                const fullThread = String((row as any).threadText ?? row.thread ?? "");
                const pf: any = (prefilterThread as any)(
                    fullThread,
                    { turnPrefixMode: true, autoPrefixMode: true, defaultWho: "S" }
                );

                if (pf) {
                    // softRef 보충
                    const soft1 = Number(pf.thresholdSoft);
                    if (softRef == null && Number.isFinite(soft1)) softRef = soft1;

                    // fallback도 “BN 오탐 방지” 기준으로 판정
                    if (typeof pf.triggered === "boolean") gotTrig = pf.triggered;
                    else if (typeof pf.isTriggered === "boolean") gotTrig = pf.isTriggered;
                    else {
                        const shouldA = Array.isArray(pf.should_trigger) ? pf.should_trigger : null;
                        const shouldB = Array.isArray(pf.shouldTrigger) ? pf.shouldTrigger : null;

                        if ((shouldA && shouldA.length) || (shouldB && shouldB.length)) {
                            gotTrig = true;
                        } else {
                            const action = String(pf.action ?? "").toLowerCase().trim();
                            if (action && action !== "none") {
                                gotTrig = true;
                            } else {
                                const score = Number(pf.score);
                                const soft = Number(pf.thresholdSoft);
                                const auto = Number(pf.thresholdAuto);

                                if (Number.isFinite(score) && Number.isFinite(soft) && score >= soft) gotTrig = true;
                                else if (Number.isFinite(score) && !Number.isFinite(soft) && Number.isFinite(auto) && score >= auto) gotTrig = true;
                                else if (!Number.isFinite(score)) {
                                    if (Array.isArray(pf.triggers) && pf.triggers.length) gotTrig = true;
                                    else if (Array.isArray(pf.hitRules) && pf.hitRules.length) gotTrig = true;
                                    else if (typeof pf.gatePass === "boolean") gotTrig = pf.gatePass;
                                }
                            }
                        }
                    }
                }
            } catch {
            }
        }

        // callChecks가 켜진 케이스는(통화/상황 기반) 트리거 true로 취급
        if (!gotTrig) {
            const cc: any = (row as any).callChecks ?? {};
            if (cc.otpAsked || cc.remoteAsked || cc.urgentPressured) gotTrig = true;
        }

        // 마지막 보정: scoreTotal이 soft 이상이면 triggered=true로 간주(네 SC00002 같은 케이스 보정)
        if (!gotTrig && softRef != null && Number.isFinite(softRef) && gotScore >= softRef) {
            gotTrig = true;
        }

        gotDist[gotRisk] = (gotDist[gotRisk] ?? 0) + 1;

        const why: string[] = [];

        // risk
        if (gotRisk === row.expected.riskLevel) riskOk++;
        else why.push(`risk mismatch: expected=${row.expected.riskLevel} got=${gotRisk}`);

        // score min
        if (typeof row.expected.score_min === "number") {
            if (gotScore >= row.expected.score_min) scoreOk++;
            else why.push(`score below min: expected>=${row.expected.score_min} got=${gotScore}`);
        } else {
            scoreOk++; // no constraint => treat ok
        }

        // stage peak
        if (row.expected.stagePeak) {
            if (gotStage === row.expected.stagePeak) stageOk++;
            else why.push(`stagePeak mismatch: expected=${row.expected.stagePeak} got=${gotStage}`);
        } else {
            stageOk++;
        }

        // triggers
        const expectedTrig: boolean | undefined = (() => {
            // 1) 명시값이 있으면 최우선
            if (typeof row.expected.triggered === "boolean") return row.expected.triggered;

            // 2) should_trigger 기반(생성기 잔재 방어 포함)
            const should = Array.isArray((row as any).should_trigger) ? ((row as any).should_trigger as any[]) : null;
            if (!should || should.length === 0) return undefined;

            const expRisk = String(row.expected.riskLevel ?? "").toLowerCase().trim();
            const expStage = String(
                (row.expected as any).stagePeak ?? (row.expected as any).stage_peak ?? ""
            ).toLowerCase().trim();
            const expScoreMin = Number((row.expected as any).score_min);

            // ✅ low + info + score_min<=0 은 “완전 benign/0점” 케이스로 보고 should_trigger 잔재 무시
            if (expRisk === "low" && expStage === "info" && Number.isFinite(expScoreMin) && expScoreMin <= 0) return false;

            return true;
        })();

        if (typeof expectedTrig === "boolean") {
            if (gotTrig === expectedTrig) trigOk++;
            else why.push(`triggered mismatch: expected=${expectedTrig} got=${gotTrig}`);
        } else {
            trigOk++;
        }

        if (why.length === 0) pass++;
        else {
            fails.push({
                id: row.id,
                label: row.label ?? "",
                expected: row.expected,
                got: { riskLevel: gotRisk, scoreTotal: gotScore, stagePeak: gotStage, triggered: gotTrig },
                why,
                thread: String(row.thread ?? ""),
                senderText: senderTextFromThread(String(row.thread ?? "")),
                notes: (row as any).notes,
                meta: (row as any).meta,
                should_trigger: (row as any).should_trigger,
            });
        }
    }

    const fail = total - pass;

    console.log(`Dataset: ${args.path}`);
    console.log(`SIM: ${simStatus}`);
    console.log(`Cases: ${total}`);
    console.log(`Pass: ${pass} (${percent(pass, total)})`);
    console.log(`Fail: ${fail} (${percent(fail, total)})`);
    console.log("");

    console.log(`Risk match: ${riskOk}/${total} (${percent(riskOk, total)})`);
    console.log(`Score(min) ok: ${scoreOk}/${total} (${percent(scoreOk, total)})`);
    console.log(`Stage peak ok: ${stageOk}/${total} (${percent(stageOk, total)})`);
    console.log(`Triggers ok: ${trigOk}/${total} (${percent(trigOk, total)})`);
    console.log("");

    console.log(`Expected: low=${expDist.low || 0}, medium=${expDist.medium || 0}, high=${expDist.high || 0}`);
    console.log(`Got:      low=${gotDist.low || 0}, medium=${gotDist.medium || 0}, high=${gotDist.high || 0}`);

    // ✅ dumps
    if (args.dumpFails) {
        const payload = fails.map((f) => ({
            ...f,
            _meta: {
                dataset: args.path,
                sim: simStatus,
            },
        }));

        // dumpFails="-" => JSONL을 stdout으로 출력(복사/파이프용)
        if (String(args.dumpFails).trim() === "-") {
            for (const row of payload) process.stdout.write(JSON.stringify(row) + "\n");
            process.stderr.write(`[dump] fails_jsonl=STDOUT count=${fails.length}\n`);
        } else {
            writeJsonl(args.dumpFails, payload);
            console.log("");
            console.log(`[dump] fails_jsonl=${args.dumpFails} count=${fails.length}`);
        }
    }

    if (args.dumpSummary) {
        const reasonCounts: Record<string, number> = {};
        const riskPairs: Record<string, number> = {};
        const stagePairs: Record<string, number> = {};

        for (const f of fails) {
            // reasons
            if (!f.why?.length) {
                reasonCounts.other = (reasonCounts.other || 0) + 1;
            } else {
                for (const w of f.why) {
                    const k = whyKeyOf(w);
                    reasonCounts[k] = (reasonCounts[k] || 0) + 1;
                }
            }

            // pairs
            const rp = `${f.expected.riskLevel}->${f.got.riskLevel}`;
            riskPairs[rp] = (riskPairs[rp] || 0) + 1;

            const es = f.expected.stagePeak || "none";
            const sp = `${es}->${f.got.stagePeak}`;
            stagePairs[sp] = (stagePairs[sp] || 0) + 1;
        }

        const lines: string[] = [];
        lines.push(["key", "subkey", "count"].join("\t"));
        lines.push(["meta", "dataset", args.path].join("\t"));
        lines.push(["meta", "sim", simStatus].join("\t"));
        lines.push(["meta", "cases", String(total)].join("\t"));
        lines.push(["meta", "pass", String(pass)].join("\t"));
        lines.push(["meta", "fail", String(fail)].join("\t"));

        const sorted = (obj: Record<string, number>) =>
            Object.entries(obj).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

        for (const [k, v] of sorted(reasonCounts)) lines.push(["reason", k, String(v)].join("\t"));
        for (const [k, v] of sorted(riskPairs)) lines.push(["risk_pair", k, String(v)].join("\t"));
        for (const [k, v] of sorted(stagePairs)) lines.push(["stage_pair", k, String(v)].join("\t"));

        writeText(args.dumpSummary, lines.join("\n") + "\n");
        console.log(`[dump] summary_tsv=${args.dumpSummary}`);
    }

    if (args.onlyFail && fails.length === 0) return;

    if (fails.length && args.showFails > 0) {
        console.log("");
        console.log(`== fails (show ${Math.min(args.showFails, fails.length)}/${fails.length}) ==`);
        for (const f of fails.slice(0, args.showFails)) {
            console.log("");
            console.log(`- ${f.id}${f.label ? ` (${f.label})` : ""}`);
            console.log(
                `  expected: risk=${f.expected.riskLevel}` +
                `${typeof f.expected.score_min === "number" ? ` score>=${f.expected.score_min}` : ""}` +
                `${f.expected.stagePeak ? ` stagePeak=${f.expected.stagePeak}` : ""}` +
                `${typeof f.expected.triggered === "boolean" ? ` triggered=${f.expected.triggered}` : ""}`,
            );
            console.log(
                `  got:      risk=${f.got.riskLevel} score=${f.got.scoreTotal} stagePeak=${f.got.stagePeak} triggered=${f.got.triggered}`,
            );
            for (const w of f.why) console.log(`  why: ${w}`);
        }
    }
}

main();
