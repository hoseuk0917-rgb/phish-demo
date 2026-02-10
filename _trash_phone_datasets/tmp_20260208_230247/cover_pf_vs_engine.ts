import fs from "fs";
import readline from "readline";
import { prefilterThread } from "../src/engine/prefilter/prefilter";
import { normalizeText } from "../src/engine/extract/normalize";
import { splitThread } from "../src/engine/extract/splitThread";
import { scoreThread } from "../src/engine/scoring/scoreThread";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function getId(o: any): string {
    return String(o?.id ?? o?.case_id ?? o?.caseId ?? o?.name ?? "");
}

function getThreadText(o: any): string {
    if (typeof o?.threadText === "string") return o.threadText;
    if (typeof o?.thread === "string") return o.thread;
    if (Array.isArray(o?.threadBlocks)) return o.threadBlocks.map((x: any) => String(x ?? "")).join("\n");
    if (typeof o?.text === "string") return o.text;
    return "";
}

function extractSenderOnlyText(thread: string): string {
    const t = String(thread || "").replace(/\r\n/g, "\n");
    const lines = t.split("\n");
    const sLines = lines
        .map((l) => {
            const m = l.match(/^\s*S\s*:\s*(.*)$/i);
            return m ? String(m[1] || "").trim() : "";
        })
        .filter(Boolean);
    return sLines.length > 0 ? sLines.join("\n") : t;
}

function normLabel(x: any): string {
    return String(x ?? "")
        .replace(/\s+/g, " ")
        .trim();
}

// pf 개념 ↔ 엔진 개념(대부분 “이름만 다른” 케이스)
const PF_TO_ENGINE_HIT_IDS: Record<string, string[]> = {
    pf_visit_place: ["visit_place", "ctx_visit_place", "go_bank_atm"],
    pf_transfer: ["transfer", "ctx_payment_request", "safe_account", "ctx_transfer_phrase", "ctx_pay_with_link"],
    pf_threat: ["threat"],
    pf_remote: ["remote", "call_remote"],
    pf_otp: ["otp", "call_otp", "ctx_otp_finance"],
    pf_otp_demand: ["ctx_otp_relay", "ctx_otp_finance_relay", "ctx_otp_proxy", "ctx_otp_proxy_after_demand"],

    // ✅ 여기 2개가 핵심 (urgent/urgency 혼용 + call_urgent)
    pf_urgency: ["urgent", "urgency", "call_urgent"],

    // ✅ authority는 이미 있고, 혹시 ctx_*로 나오면 같이 잡기
    pf_authority: ["authority", "ctx_authority", "institution_claim", "impersonation_authority"],

    // messenger/profile은 엔진에서 보통 “연락처 이동” 컨텍스트로 잡히는 경우가 많아서 우선 alias로 연결
    pf_messenger_profile: ["ctx_contact_move", "messenger_phishing", "ctx_messenger_profile"],

    // benefit_hook도 엔진에 있으면 id를 여기로 연결(없으면 다음 SWAP-IN B에서 엔진에 추가)
    pf_benefit_hook: ["ctx_government_benefit", "government_benefit", "benefit_hook", "ctx_benefit_hook"],

    pf_account_verify: ["account_verify", "ctx_account_verify"],
    pf_account_freeze: ["account_freeze", "ctx_account_freeze", "safe_account", "threat"],
    pf_cash_pickup: ["cash_pickup", "ctx_cash_pickup"],
    pf_job_hook: ["job_hook", "ctx_job_hook"],
    pf_pii: ["pii_request", "personalinfo", "ctx_pii_request"],
    pf_link_verbs: ["link", "shortener"],
    pf_benefit_link_mention: ["government_benefit", "ctx_government_benefit", "link", "shortener"],
    pf_url_bank_claim_nonofficial: ["url_bank_claim_nonofficial", "url_nonofficial_bank", "link"],
    pf_url_bank_typosquat: ["url_bank_typosquat", "url_typosquat", "link"],
};

// 엔진 stagePeak 트리거(문자열)로 이미 올라오는 케이스(네 로그 기반)
const PF_TO_ENGINE_STAGE_TRIGGERS: Record<string, string[]> = {
    pf_benefit_link_mention: ["맥락: 지원/환급/대상자 조회 + 링크 언급"],
    pf_cash_pickup: ["맥락: 현금 수거/퀵 전달 유도"],
};

type Stat = {
    id: string;
    label: string;
    n_pf: number;
    direct_hitId: number;
    direct_hitLabel: number;
    direct_signalId: number;
    direct_signalLabel: number;
    alias_hit: number;
    alias_stageTrigger: number;
    ex_case: string;
};

async function main() {
    const path =
        arg("--path") || "./datasets/ko_scam/regression_v3_482_engineAligned_2026-01-30.policyRelabeled.jsonl";
    const outPath = arg("--out") || "./tmp/pf_vs_engine_coverage.tsv";

    const rl = readline.createInterface({ input: fs.createReadStream(path, { encoding: "utf8" }) });
    const out = fs.createWriteStream(outPath, { encoding: "utf8" });

    const stats: Record<string, Stat> = {};
    let total = 0;

    for await (const line of rl) {
        const l = String(line || "").trim();
        if (!l) continue;

        total++;
        const obj: any = JSON.parse(l);
        const caseId = getId(obj) || `ROW_${total}`;

        const threadTextRaw = getThreadText(obj);
        if (!threadTextRaw.trim()) continue;

        const threadText = String(threadTextRaw).replace(/\r\n/g, "\n");

        // PF는 S-only 기준(정책)
        const sText = extractSenderOnlyText(threadText);
        const pf: any = prefilterThread(sText);
        const pfSignals: any[] = Array.isArray(pf?.signals) ? pf.signals : [];

        const pfPairs = pfSignals
            .map((s) => ({
                id: String(s?.id ?? s?.ruleId ?? "").trim(),
                label: normLabel(s?.label ?? s?.name ?? s?.title ?? ""),
            }))
            .filter((x) => x.id);

        if (pfPairs.length === 0) continue;

        // 엔진 커버 확인도 Threat 정책(S-only) 기준으로 맞춘다
        // (splitThread가 S/R을 한 블록으로 합치면서 includeInThreat가 흔들리는 케이스 방지)
        const normThread = normalizeText(sText);
        const messages = splitThread(normThread);

        const scored: any = scoreThread(messages, (obj?.callChecks ?? undefined) as any, undefined as any);

        const hitIds = new Set<string>(
            (Array.isArray(scored?.hits) ? scored.hits : [])
                .map((h: any) => String(h?.ruleId ?? "").trim())
                .filter(Boolean)
        );

        const hitLabels = new Set<string>(
            (Array.isArray(scored?.hits) ? scored.hits : [])
                .map((h: any) => normLabel(h?.label ?? ""))
                .filter(Boolean)
        );

        const sigIds = new Set<string>(
            (Array.isArray(scored?.signals) ? scored.signals : [])
                .map((s: any) => String(s?.id ?? "").trim())
                .filter(Boolean)
        );

        const sigLabels = new Set<string>(
            (Array.isArray(scored?.signals) ? scored.signals : [])
                .map((s: any) => normLabel(s?.label ?? ""))
                .filter(Boolean)
        );

        const stageTrigLabels = new Set<string>(
            (Array.isArray(scored?.stageTriggers) ? scored.stageTriggers : [])
                .map((x: any) => normLabel(x))
                .filter(Boolean)
        );

        for (const p of pfPairs) {
            const key = p.id;
            if (!stats[key]) {
                stats[key] = {
                    id: key,
                    label: p.label,
                    n_pf: 0,
                    direct_hitId: 0,
                    direct_hitLabel: 0,
                    direct_signalId: 0,
                    direct_signalLabel: 0,
                    alias_hit: 0,
                    alias_stageTrigger: 0,
                    ex_case: "",
                };
            }
            const st = stats[key];
            st.n_pf += 1;
            if (!st.ex_case) st.ex_case = caseId;
            if (!st.label && p.label) st.label = p.label;

            // direct
            if (hitIds.has(key)) st.direct_hitId += 1;
            if (p.label && hitLabels.has(p.label)) st.direct_hitLabel += 1;
            if (sigIds.has(key)) st.direct_signalId += 1;
            if (p.label && sigLabels.has(p.label)) st.direct_signalLabel += 1;

            // alias hit ids
            const aliases = PF_TO_ENGINE_HIT_IDS[key] || [];
            if (aliases.some((a) => hitIds.has(a))) st.alias_hit += 1;

            // alias stage triggers (문자열)
            const trigAliases = PF_TO_ENGINE_STAGE_TRIGGERS[key] || [];
            if (trigAliases.some((a) => stageTrigLabels.has(a))) st.alias_stageTrigger += 1;
        }
    }

    out.write(
        [
            "pf_id",
            "pf_label",
            "n_pf",
            "direct_hitId",
            "direct_hitLabel",
            "direct_signalId",
            "direct_signalLabel",
            "alias_hit",
            "alias_stageTrigger",
            "example_case",
            "status",
        ].join("\t") + "\n"
    );

    const rows = Object.values(stats).sort((a, b) => b.n_pf - a.n_pf);

    const missing: Stat[] = [];
    for (const r of rows) {
        const covered =
            r.direct_hitId > 0 ||
            r.direct_hitLabel > 0 ||
            r.direct_signalId > 0 ||
            r.direct_signalLabel > 0 ||
            r.alias_hit > 0 ||
            r.alias_stageTrigger > 0;

        if (!covered) missing.push(r);

        out.write(
            [
                r.id,
                r.label,
                r.n_pf,
                r.direct_hitId,
                r.direct_hitLabel,
                r.direct_signalId,
                r.direct_signalLabel,
                r.alias_hit,
                r.alias_stageTrigger,
                r.ex_case,
                covered ? "OK" : "MISSING",
            ].join("\t") + "\n"
        );
    }

    out.end();

    console.log(`total_cases_scanned=${total}`);
    console.log(`wrote -> ${outPath}`);
    console.log(`pf_ids=${rows.length} missing=${missing.length}`);
    console.log("top missing (up to 20):");
    for (const m of missing.slice(0, 20)) {
        console.log(`- ${m.id} (${m.label || "no-label"}) n_pf=${m.n_pf} ex=${m.ex_case}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
