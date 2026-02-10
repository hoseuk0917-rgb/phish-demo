// tools/analysis/extractSignals.ts  (SWAP-IN)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeText } from "./normalizeText";
import type { Signal } from "./types";

type Rule = {
    key: string;
    label: string;
    category: string;
    re: RegExp;
};

type AnyObj = Record<string, any>;

function parseArgs(argv: string[]) {
    const out: AnyObj = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const k = a.slice(2);
        const v = argv[i + 1];
        if (!v || v.startsWith("--")) out[k] = true;
        else {
            out[k] = v;
            i++;
        }
    }
    return out;
}

function asBool(v: any, def: boolean) {
    if (v === undefined) return def;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    return true;
}

function clampText(s: string, maxChars: number) {
    const t = String(s ?? "");
    if (maxChars <= 0) return t;
    return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function posixRel(p: string) {
    return path.relative(process.cwd(), p).replace(/\\/g, "/");
}

function readTextFileSafe(relOrAbs: string) {
    try {
        const p = path.isAbsolute(relOrAbs)
            ? relOrAbs
            : path.resolve(process.cwd(), relOrAbs.replace(/\//g, path.sep));
        if (!fs.existsSync(p)) return "";
        return fs.readFileSync(p, "utf8");
    } catch {
        return "";
    }
}

function walkFiles(dir: string, acc: string[]) {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(p, acc);
        else acc.push(p);
    }
}

// signals/cluster 과매칭 유발하는 공통 안내문구 제거
const BOILERPLATE: RegExp[] = [
    /경찰청\s*-\s*금융사기\s*통합\s*신고\s*대응\s*센터/gi,
    /금융사기\s*통합\s*신고\s*대응\s*센터/gi,
    /보이스\s*피싱/gi,
    /스미싱/gi,
    /접수\s*부터\s*처리\s*까지/gi,
    /자주\s*묻는\s*질문/gi,
    /FAQ/gi,
];

function stripBoilerplate(text: string): string {
    let t = text;
    for (const re of BOILERPLATE) t = t.replace(re, " ");
    return normalizeText(t);
}

const RULES: Rule[] = [
    // meta (portal/template pages)
    {
        key: "meta:portal",
        label: "포털/안내 페이지",
        category: "meta",
        re: /(통합\s*신고).{0,120}(대응\s*센터|안내|접수|처리)/i,
    },

    // channel
    { key: "channel:sms", label: "문자/SMS", category: "channel", re: /(문자|sms|mms|lms|알림톡)/i },
    { key: "channel:call", label: "전화/통화", category: "channel", re: /(전화|통화|ars|콜센터|보이스\s*피싱)/i },
    { key: "channel:kakao", label: "카카오톡", category: "channel", re: /(카카오톡|카톡|kakaotalk)/i },
    { key: "channel:telegram", label: "텔레그램", category: "channel", re: /(텔레그램|telegram)/i },
    { key: "channel:email", label: "이메일", category: "channel", re: /(이메일|email|메일)/i },

    // action
    { key: "action:transfer", label: "송금/이체", category: "action", re: /(송금|이체|입금|계좌\s*이체|대포\s*통장|계좌번호)/i },
    { key: "action:cash", label: "현금/인출", category: "action", re: /(현금|인출|출금|atm)/i },
    { key: "action:otp", label: "OTP/인증번호", category: "action", re: /(otp|인증\s*번호|인증\s*코드|보안\s*코드|일회용\s*비밀번호|2차\s*인증)/i },
    { key: "action:remote", label: "원격제어", category: "action", re: /(원격|원격\s*제어|teamviewer|팀\s*뷰어|anydesk|애니\s*데스크|quick\s*support|퀵\s*서포트)/i },
    { key: "action:install", label: "설치/APK", category: "action", re: /(apk|앱\s*설치|어플\s*설치|프로그램\s*설치|출처\s*알\s*수\s*없는\s*앱|알\s*수\s*없는\s*출처|권한\s*허용)/i },
    { key: "action:phish_link", label: "링크/URL", category: "action", re: /(https?:\/\/|bit\.ly|tinyurl|링크|url|주소\s*클릭)/i },
    { key: "action:loan", label: "대출", category: "action", re: /(대출|금리|한도|저금리|고금리|대환)/i },
    { key: "action:job", label: "취업/부업", category: "action", re: /(취업|채용|알바|부업|재택|구인)/i },

    // impersonation
    { key: "imp:police", label: "경찰 사칭", category: "impersonation", re: /(경찰|경찰청|수사관|형사|사이버\s*수사)/i },
    { key: "imp:prosecutor", label: "검찰 사칭", category: "impersonation", re: /(검찰|검사|검찰청)/i },
    { key: "imp:court", label: "법원/영장 사칭", category: "impersonation", re: /(법원|영장|체포|구속|재판)/i },
    { key: "imp:bank", label: "금융기관 사칭", category: "impersonation", re: /(은행|금감원|금융감독원|카드사|고객센터)/i },
    { key: "imp:courier", label: "택배/배송 사칭", category: "impersonation", re: /(택배|배송|우체국|물류|운송장)/i },

    // platforms
    { key: "platform:toss", label: "토스", category: "platform", re: /(토스|toss)/i },
    { key: "platform:kakaobank", label: "카카오뱅크", category: "platform", re: /(카카오\s*뱅크|kakaobank)/i },

    // pressure / threats
    { key: "pressure:threat", label: "협박/압박", category: "pressure", re: /(협박|구속|체포|즉시|지금\s*당장|벌금|압류|계좌\s*동결|긴급)/i },
];

function takeExamples(text: string, re: RegExp, max = 2) {
    const ex: string[] = [];
    const lines = normalizeText(text)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    for (const ln of lines) {
        if (re.test(ln)) {
            ex.push(ln.slice(0, 140));
            if (ex.length >= max) break;
        }
    }
    return ex;
}

export function extractSignals(bodyText: string, attachmentNames: string[] = []): Signal[] {
    const raw = normalizeText(bodyText + "\n" + attachmentNames.join("\n"));
    const text = stripBoilerplate(raw);

    const map: Record<string, Signal> = {};

    for (const r of RULES) {
        const flags = r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g";
        const m = text.match(new RegExp(r.re.source, flags));
        const count = m ? m.length : 0;
        if (count <= 0) continue;

        map[r.key] = {
            key: r.key,
            label: r.label,
            category: r.category,
            count,
            examples: takeExamples(text, r.re, 2),
        };
    }

    return Object.values(map).sort((a, b) => b.count - a.count);
}

export function buildSignature(signals: Signal[]): string {
    const has = (key: string) => signals.some((s) => s.key === key);
    const pick = (cat: string) =>
        signals.filter((s) => s.category === cat).sort((a, b) => b.count - a.count)[0]?.key ?? `${cat}:none`;

    const nonMeta = signals.filter((s) => s.category !== "meta");
    if (has("meta:portal") && nonMeta.length === 0) {
        return "channel:portal|action:portal|imp:portal";
    }

    const channel = pick("channel");
    const action = pick("action");
    const imp = pick("impersonation");
    return [channel, action, imp].join("|");
}

function listNormalizedJson(inDir: string) {
    const all: string[] = [];
    walkFiles(inDir, all);
    return all.filter((p) => /pstSn_\d+\.json$/i.test(path.basename(p)));
}

function getAttachmentNames(doc: any) {
    const arr = Array.isArray(doc?.attachments) ? doc.attachments : [];
    const names: string[] = [];
    for (const a of arr) {
        const n = String(a?.name ?? "").trim();
        if (n) names.push(n);
        else if (a?.saved_as) names.push(path.basename(String(a.saved_as)));
    }
    return names;
}

function getAttachmentTextBlock(doc: any, maxChars: number) {
    const at = Array.isArray(doc?.attachment_texts) ? doc.attachment_texts : [];
    if (!at.length) return "";

    let merged = "";
    for (const t of at) {
        const rel = String(t?.text_path ?? "").trim();
        if (!rel) continue;
        const s = readTextFileSafe(rel);
        if (!s) continue;
        merged += "\n\n[ATT_TEXT]\n" + s;
        if (merged.length >= maxChars) break;
    }
    return clampText(merged, maxChars);
}

async function runCli() {
    const args = parseArgs(process.argv);

    const inDir = path.resolve(String(args.inDir || "./corpus/derived/normalized"));
    const outDir = path.resolve(String(args.outDir || "./corpus/derived/signals"));
    const includeAttachmentText = asBool(args.includeAttachmentText, true);
    const maxAttachChars = Number(args.maxAttachChars || 80000);
    const debug = asBool(args.debug, false);

    if (!fs.existsSync(inDir) || !fs.statSync(inDir).isDirectory()) {
        console.error(`ERROR: inDir not found: ${inDir}`);
        process.exit(1);
    }

    fs.mkdirSync(outDir, { recursive: true });

    const files = listNormalizedJson(inDir);

    let n = 0;
    const index: any[] = [];

    for (const f of files) {
        let doc: any = null;
        try {
            doc = JSON.parse(fs.readFileSync(f, "utf8"));
        } catch (e) {
            if (debug) console.log("[SKIP_BAD_JSON]", posixRel(f), String(e));
            continue;
        }

        const source = String(doc?.source ?? "").trim() || path.basename(path.dirname(f));
        const pstSn = String(doc?.pstSn ?? "").trim();
        const body = String(doc?.body_text ?? "");

        if (!pstSn || !body) continue;

        const attachmentNames = getAttachmentNames(doc);
        const attText = includeAttachmentText ? getAttachmentTextBlock(doc, maxAttachChars) : "";
        const merged = body + (attText ? "\n" + attText : "");

        const signals = extractSignals(merged, attachmentNames);
        const signature = buildSignature(signals);

        const outObj = {
            source,
            pstSn,
            title: doc?.title,
            date: doc?.date,
            signature,
            signals,
            meta: {
                generated_at: new Date().toISOString(),
                body_chars: body.length,
                attachment_names: attachmentNames.length,
                attachment_text_included: includeAttachmentText,
            },
            raw_paths: {
                normalized_json: posixRel(f),
            },
        };

        const outPath = path.join(outDir, source, `pstSn_${pstSn}.json`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(outObj, null, 2), "utf8");

        index.push({
            source,
            pstSn,
            signature,
            top: signals.slice(0, 8).map((s) => ({ key: s.key, count: s.count })),
            out: posixRel(outPath),
        });

        n++;
    }

    const idxPath = path.join(outDir, "_index.json");
    fs.writeFileSync(idxPath, JSON.stringify(index, null, 2), "utf8");

    console.log(`signals_written: ${n}`);
    console.log(`outDir: ${outDir}`);
    console.log(`index: ${idxPath}`);
}

function isMain() {
    try {
        const me = path.resolve(fileURLToPath(import.meta.url));
        const entry = path.resolve(process.argv[1] || "");
        return me === entry;
    } catch {
        return false;
    }
}

if (isMain()) {
    runCli().catch((e) => {
        console.error("FATAL:", e);
        process.exit(1);
    });
}
