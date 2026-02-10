// tools/analysis/relabelDatasetFromEngine.ts — SWAP-IN (policy-aligned)
import fs from "node:fs";
import path from "node:path";

import { analyzeThread } from "../../src/engine";
import type { AnalysisInput, AnalysisResult, StageId, RiskLevel } from "../../src/types/analysis";

type AnyObj = Record<string, any>;

function usage(): never {
    console.log(
        "Usage: --in <path> --out <path> [--margin N] [--limit N]\n" +
        "  --margin: score_min = max(0, round(threshold(riskLevel) - margin)) (default 5)\n" +
        "           threshold: low=0, medium=35, high=65\n" +
        "  policy: high is allowed ONLY when hardHigh=true\n"
    );
    process.exit(1);
}

function parseArgs(argv: string[]) {
    const args: AnyObj = { margin: 5 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--in") args.in = next();
        else if (a === "--out") args.out = next();
        else if (a === "--margin") args.margin = Number(next());
        else if (a === "--limit") args.limit = Number(next());
        else if (a === "--help" || a === "-h") usage();
    }
    if (!args.in || !args.out) usage();
    if (!Number.isFinite(args.margin)) args.margin = 5;
    if (args.limit != null && !Number.isFinite(args.limit)) delete args.limit;
    return args as { in: string; out: string; margin: number; limit?: number };
}

function readJsonl(p: string): AnyObj[] {
    const txt = fs.readFileSync(p, "utf8");
    return txt
        .split(/\r?\n/g)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line, idx) => {
            try {
                return JSON.parse(line);
            } catch (e) {
                throw new Error(`JSON parse failed at line ${idx + 1}: ${(e as Error).message}`);
            }
        });
}

function writeJsonl(p: string, rows: AnyObj[]) {
    const out = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, out, "utf8");
}

const STAGE_RANK: Record<StageId, number> = { info: 0, verify: 1, install: 2, payment: 3 };

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

function pickThreadText(row: any): string {
    const t =
        row?.threadText ??
        row?.thread ??
        row?.rawThreadText ??
        row?.rawThread ??
        row?.text ??
        row?.input ??
        "";
    return String(t ?? "");
}

function pickRisk(v: any): RiskLevel | "" {
    const s = String(v ?? "").toLowerCase().trim();
    if (s === "low" || s === "medium" || s === "high") return s as RiskLevel;
    return "";
}

// ✅ runDataset의 hardHigh 탐색과 동일 계열로 맞춤
function hardHighFromResult(res: any): boolean | undefined {
    if (!res || typeof res !== "object") return undefined;

    // ✅ 결과에 hardHigh 힌트가 "존재"하는 경우에만 true/false 판정
    const hasAny =
        ("hardHigh" in res) ||
        (!!(res as any)?.flags && typeof (res as any).flags === "object" && ("hardHigh" in (res as any).flags)) ||
        (!!(res as any)?.meta && typeof (res as any).meta === "object" && ("hardHigh" in (res as any).meta)) ||
        (!!(res as any)?.escalation && typeof (res as any).escalation === "object" && ("hardHigh" in (res as any).escalation));

    if (!hasAny) return undefined;

    return Boolean(
        (res as any).hardHigh ??
        (res as any).flags?.hardHigh ??
        (res as any).meta?.hardHigh ??
        (res as any).escalation?.hardHigh
    );
}

// ✅ 정책: high는 hardHigh에서만 허용
function policyRiskFromResult(res: any, scoreTotal: number): RiskLevel {
    const hardHighFlag = hardHighFromResult(res);

    const raw = pickRisk(res?.riskLevel ?? res?.risk ?? res?.riskLevelId ?? res?.risk_level);
    if (raw) {
        // ✅ hardHigh가 "명시적으로 false"일 때만 high를 medium으로 내림
        if (raw === "high" && hardHighFlag === false) return "medium";
        return raw;
    }

    // fallback: score로 high 금지
    if (hardHighFlag === true) return "high";
    if (Number.isFinite(scoreTotal) && scoreTotal >= 35) return "medium";
    return "low";
}

function pickCallChecks(row: any): any {
    // - boolean(true/false)은 그대로 전달(엔진 auto/enable 모드 호환)
    // - object면 기본값에 merge
    // - 없으면 runDataset 기본과 맞추기 위해 true를 기본값으로 사용
    const rawCall = (row as any)?.callChecks;

    if (typeof rawCall === "boolean") return rawCall;

    if (rawCall && typeof rawCall === "object") {
        return {
            otpAsked: false,
            remoteAsked: false,
            urgentPressured: false,
            firstContact: false,
            ...rawCall,
        };
    }

    return true;
}

async function main() {
    const { in: inPath, out: outPath, margin, limit } = parseArgs(process.argv.slice(2));

    const rows = readJsonl(inPath);
    const n = limit ? Math.min(limit, rows.length) : rows.length;

    let relabeled = 0;
    let failed = 0;

    const errCount = new Map<string, number>();

    for (let i = 0; i < n; i++) {
        const r = rows[i];
        const thread = pickThreadText(r);

        if (!thread.trim()) {
            r._relabel_error = "empty thread";
            failed++;
            errCount.set("empty thread", (errCount.get("empty thread") ?? 0) + 1);
            continue;
        }

        try {
            const callChecks = pickCallChecks(r);

            const input: AnalysisInput = {
                threadText: thread,
                callChecks: callChecks as any,
            };

            const res = analyzeThread(input);

            const scoreTotal = Number((res as any).scoreTotal ?? 0);
            const riskLevel = policyRiskFromResult(res as any, scoreTotal);
            const stagePeak = stagePeakFromResult(res);
            const hardHigh = hardHighFromResult(res as any);

            const baseMin =
                riskLevel === "high" ? 65 :
                    riskLevel === "medium" ? 35 : 0;

            const scoreMinByThreshold = Math.max(0, Math.round(baseMin - margin));
            const scoreMinByScore = Math.max(0, Math.round(scoreTotal - margin));
            const scoreMin = Math.min(scoreMinByThreshold, scoreMinByScore);

            // 입력 필드 동기화(툴/러너가 뭘 보더라도 동일 텍스트)
            (r as any).thread = thread;
            (r as any).threadText = thread;

            // expected는 기존 필드 최대한 보존 + 핵심만 덮어씀
            const exp: AnyObj = r.expected && typeof r.expected === "object" ? { ...r.expected } : {};
            // ✅ runDataset 호환: expected.risk 를 반드시 동기화
            exp.risk = riskLevel;
            exp.riskLevel = riskLevel;
            exp.risk_level = riskLevel; // 호환
            exp.score_min = scoreMin;
            exp.stagePeak = stagePeak;
            exp.stage_peak = stagePeak; // 호환

            r.label = riskLevel;
            r.expected = exp;

            // ✅ trigger 정합(존재하면 closure 적용): job_lure ⇒ ctx_job_hook
            const stRaw = (r as any).should_trigger;
            if (Array.isArray(stRaw)) {
                const st = [...new Set(stRaw.map((x) => String(x ?? "").trim()).filter(Boolean))];
                if (st.includes("job_lure") && !st.includes("ctx_job_hook")) st.push("ctx_job_hook");
                (r as any).should_trigger = st;
            }

            // ✅ low 라벨은 trigger 검증을 하지 않도록 잔재 제거
            if (riskLevel === "low") {
                delete (r as any).should_trigger;
                if (r.expected && typeof r.expected === "object") delete (r.expected as any).triggered;
            }

            // 디버그 메타(원인 추적용)
            (r as any).meta_engine = {
                scoreTotal,
                hardHigh,
                rawRisk: pickRisk((res as any)?.riskLevel ?? (res as any)?.risk ?? (res as any)?.riskLevelId),
                policyRisk: riskLevel,
            };

            delete r._relabel_error;
            relabeled++;
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            r._relabel_error = msg;
            failed++;
            errCount.set(msg, (errCount.get(msg) ?? 0) + 1);
        }
    }

    writeJsonl(outPath, rows);

    const top = [...errCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [m, c] of top) console.log(`[relabel:error] x${c} ${m}`);

    console.log(
        `[relabelDatasetFromEngine] in=${inPath} out=${outPath} relabeled=${relabeled} failed=${failed}`
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
