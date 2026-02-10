// tools/analysis/genScenariosFromStubs.ts
// 목적: stubs(jsonl) -> scenarios(jsonl) 생성 (DEMO/방어용, 비기능 URL/번호만 사용)
// 실행: npx tsx tools/analysis/genScenariosFromStubs.ts --stubs ... --out ... --count 500 --seed 42

import fs from "node:fs/promises";
import path from "node:path";

type AnyObj = Record<string, any>;

type CallerClass = "official_landline" | "mobile" | "voip070" | "unknown" | "spoofed";
type Channel = "sms" | "call" | "chat";
type Vector = "none" | "url" | "qr";
type UrlKind = "official" | "typo" | "homoglyph" | "short";
type Anchor =
    | "A_LINK"
    | "A_QR"
    | "A_OTP"
    | "A_INSTALL"
    | "A_TRANSFER"
    | "A_GO_BANK"
    | "A_CASH_PICKUP"
    | "A_TRAVEL"
    | "A_CRED"
    | "A_PII";

type Risk = "low" | "medium" | "high";
type Stage = "info" | "verify" | "install" | "payment";

type ScenarioTurn = { role: "S" | "R"; text: string };

type ScenarioInternal = {
    id: string;
    caseType: CaseType;
    channel: Channel;
    caller: {
        caller_id: string;
        caller_display: string; // DEMO 가상 표기
        caller_class: CallerClass;
        is_whitelisted: boolean;
        is_first_seen: boolean;
    };
    vector: Vector;
    url?: { kind: UrlKind; value: string; count: 0 | 1; match?: boolean; official_id?: string };
    qr?: { target_kind: UrlKind; note: string; match?: boolean; official_id?: string };
    anchors: Anchor[];
    pressures: string[]; // press_*
    impersonation?: string; // imp_*
    turns: ScenarioTurn[];
    expected: {
        risk: Risk;
        stagePeak: Stage;
        triggers: string[];
    };
    meta?: AnyObj;
};

type CaseType =
    | "delivery_link"
    | "fine_refund_link"
    | "bank_otp"
    | "bank_install"
    | "account_takeover_cred"
    | "pii_collection"
    | "family_urgent_transfer"
    | "loan_fee"
    | "go_bank_atm"
    | "cash_pickup"
    | "job_travel"
    | "blackmail_sexvisit";

type Args = {
    stubs: string;
    out: string;
    count: number;
    seed: number;
    benign_ratio: number; // 0..1
    hardneg_ratio: number; // 0..1 (benign 내부 비중)
    max_len: number; // 1..20
    max_retries: number;
    registry_out?: string;

    // ✅ 추가: direct(기본) | meta(시연용 완곡문)
    anchor_style?: AnchorStyle;
};

type AnchorStyle = "direct" | "meta";
let ANCHOR_STYLE: AnchorStyle = "direct";

function parseArgs(argv: string[]): Args {
    const a: AnyObj = {};
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (!k.startsWith("--")) continue;
        const key = k.slice(2).replace(/-/g, "_");
        const v = argv[i + 1];
        if (v && !v.startsWith("--")) {
            a[key] = v;
            i++;
        } else {
            a[key] = true;
        }
    }

    const isHelp = argv.includes("--help") || argv.includes("-h") || a.help === true;
    if (isHelp) {
        console.log(
            [
                "Usage:",
                "  npx tsx tools/analysis/genScenariosFromStubs.ts --stubs <path> --out <path> [--count N] [--seed N] ...",
                "",
                "Options:",
                "  --stubs <path>         input stubs jsonl",
                "  --out <path>           output scenarios jsonl",
                "  --count <n>            default 500",
                "  --seed <n>             default 42",
                "  --benign-ratio <0..1>  default 0.25",
                "  --hardneg-ratio <0..1> default 0.6",
                "  --max-len <1..20>      default 20",
                "  --max-retries <n>      default 12",
                "  --registry-out <path>  optional (debug)",
                "  --anchor-style <direct|meta> default direct",
                "",
                "Example:",
                "  npx tsx tools/analysis/genScenariosFromStubs.ts --stubs datasets/ko_scam/scenario_stubs_from_clusters_merged_patched.jsonl --out datasets/ko_scam/scenarios_ko_v3.jsonl --count 500 --seed 42",
            ].join("\n")
        );
        process.exit(0);
    }

    const stubs = String(a.stubs || "");
    const out = String(a.out || "");
    if (!stubs || !out) {
        throw new Error("Usage: --stubs <path> --out <path> [--count N] [--seed N] ... (try --help)");
    }

    const rawAnchorStyle = String(
        (a as any).anchor_style ?? (a as any)["anchor-style"] ?? (a as any).anchorStyle ?? "direct"
    ).toLowerCase();

    return {
        stubs,
        out,
        count: clampInt(parseInt(String(a.count || "500"), 10), 1, 200000),
        seed: clampInt(parseInt(String(a.seed || "42"), 10), 1, 2_000_000_000),
        benign_ratio: clamp01(parseFloat(String(a.benign_ratio || "0.25"))),
        hardneg_ratio: clamp01(parseFloat(String(a.hardneg_ratio || "0.6"))),
        max_len: clampInt(parseInt(String(a.max_len || "20"), 10), 1, 20),
        max_retries: clampInt(parseInt(String(a.max_retries || "12"), 10), 1, 200),
        registry_out: a.registry_out ? String(a.registry_out) : undefined,
        anchor_style: (rawAnchorStyle === "meta" ? "meta" : "direct"),
    };
}

function clamp01(x: number) {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(1, x));
}
function clampInt(x: number, lo: number, hi: number) {
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
}

function mulberry32(seed: number) {
    let t = seed >>> 0;
    return () => {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}
function pick<T>(rng: () => number, xs: readonly T[]): T {
    return xs[Math.floor(rng() * xs.length)];
}
function chance(rng: () => number, p: number) {
    return rng() < p;
}
function uniqSorted(xs: string[]) {
    return Array.from(new Set(xs)).sort();
}

function uniqAnchors(xs: Anchor[]) {
    return Array.from(new Set(xs));
}

// anchors를 “텍스트에 실제 cue가 존재하는 것만” 남김 (expected 과대/과소 방지)
function anchorsEffFromText(anchors: Anchor[], senderText: string): Anchor[] {
    const t = String(senderText || "");
    const t2 = t.replace(/\s+/g, ""); // 한국어 붙여쓰기 대응(간단)

    const hasUrl = /https?:\/\/\S+|www\./i.test(t);
    const hasQr = /(qr|큐알|QR\s*코드|스캔)/i.test(t);

    const hasOtp = /(otp|인증번호|보안코드|인증\s*번호)/i.test(t);
    const hasInstall = /(teamviewer|anydesk|원격\s*지원|원격|remote|지원앱|apk|설치|install)/i.test(t);

    // ✅ payment 계열은 "행동 동사"가 있을 때만 유지(과대예측 방지)
    const hasTransferVerb = /(송금|이체|입금|보내|transfer|remit|wire)/i.test(t) || /(송금|이체|입금|보내)/i.test(t2);
    const hasAccountRef = /(계좌|계좌번호|예금주|입금계좌)/i.test(t);

    // 계좌/예금주만 있고 '송금/입금/이체'가 없으면 payment로 올리지 않게
    const hasTransfer = hasTransferVerb && (hasAccountRef || /(송금|이체|입금|보내)/i.test(t2));

    const hasCashVerb =
        /(인출|현금\s*인출|현금\s*수령|withdraw)/i.test(t) || /(인출|현금인출|현금수령)/i.test(t2);
    const hasPickupCue = /(퀵|대면\s*전달|직접\s*전달|픽업|수거|봉투)/i.test(t) || /(대면전달|직접전달|픽업|수거|봉투)/i.test(t2);
    const hasCash = hasCashVerb || ((/현금|cash/i.test(t) || /현금/.test(t2)) && hasPickupCue);

    const hasGoBankPlace = /(은행|atm|창구)/i.test(t) || /(은행|atm|창구)/i.test(t2);
    const hasGoBankVerb =
        /(방문|가서|가라|이동|찾아|인출|입금|송금)/i.test(t) || /(방문|가서|가라|이동|찾아|인출|입금|송금)/i.test(t2);
    const hasGoBank = hasGoBankPlace && hasGoBankVerb;

    const hasTravel =
        /(해외|출국|공항|현지\s*근무|고수익|채용|항공권|여권|비자|동남아)/i.test(t) ||
        /(해외|출국|공항|현지근무|고수익|채용|항공권|여권|비자|동남아)/i.test(t2);

    const hasCred =
        /(아이디|id\b|비밀번호|password|로그인\s*정보|계정\s*정보)/i.test(t) ||
        /(아이디|비밀번호|로그인정보|계정정보)/i.test(t2);

    const hasPii =
        /(주민등록|신분증|여권|계좌\s*사본|카드번호|개인정보|사진\s*업로드|업로드|제출)/i.test(t) ||
        /(주민등록|신분증|여권|계좌사본|카드번호|개인정보|사진업로드|업로드|제출)/i.test(t2);

    const keep: Anchor[] = [];
    for (const a of anchors) {
        if (a === "A_LINK" && !hasUrl) continue;
        if (a === "A_QR" && !hasQr) continue;

        if (a === "A_OTP" && !hasOtp) continue;
        if (a === "A_INSTALL" && !hasInstall) continue;

        if (a === "A_TRANSFER" && !hasTransfer) continue;
        if (a === "A_CASH_PICKUP" && !hasCash) continue;
        if (a === "A_GO_BANK" && !hasGoBank) continue;

        if (a === "A_TRAVEL" && !hasTravel) continue;

        if (a === "A_CRED" && !hasCred) continue;
        if (a === "A_PII" && !hasPii) continue;

        keep.push(a);
    }

    return uniqAnchors(keep);
}

function safeId(prefix: string, i: number) {
    return `${prefix}${String(i).padStart(5, "0")}`;
}

// ---------- DEMO 전화번호 레지스트리(가상, 충돌 회피) ----------
type CallerRegistryEntry = {
    caller_id: string;
    caller_display: string;
    caller_class: CallerClass;
    is_whitelisted: boolean;
};

function buildCallerRegistry(): CallerRegistryEntry[] {
    // 공식: 은행/카드=15xx, 법원/검경/정부=유선
    // 악성: 010/070은 데모 안전을 위해 끝 4자리를 0000으로 고정 (랜덤 생성 금지)
    return [
        { caller_id: "OFFICIAL_BANK_MAIN", caller_display: "1588-0000", caller_class: "official_landline", is_whitelisted: true },
        { caller_id: "OFFICIAL_CARD_MAIN", caller_display: "1577-0000", caller_class: "official_landline", is_whitelisted: true },
        { caller_id: "OFFICIAL_COURT_MAIN", caller_display: "02-0000-0000", caller_class: "official_landline", is_whitelisted: true },
        { caller_id: "OFFICIAL_POLICE_MAIN", caller_display: "02-0001-0000", caller_class: "official_landline", is_whitelisted: true },
        { caller_id: "OFFICIAL_PROSECUTOR_MAIN", caller_display: "02-0002-0000", caller_class: "official_landline", is_whitelisted: true },
        { caller_id: "OFFICIAL_GOV_MAIN", caller_display: "044-000-0000", caller_class: "official_landline", is_whitelisted: true },

        // ✅ 스캠용(데모 안전): 끝 4자리 0000 고정
        { caller_id: "SCAM_MOBILE_01", caller_display: "010-0000-0000", caller_class: "mobile", is_whitelisted: false },
        { caller_id: "SCAM_MOBILE_02", caller_display: "010-0000-0000", caller_class: "mobile", is_whitelisted: false },
        { caller_id: "SCAM_070_01", caller_display: "070-0000-0000", caller_class: "voip070", is_whitelisted: false },
        { caller_id: "SCAM_070_02", caller_display: "070-0000-0000", caller_class: "voip070", is_whitelisted: false },
        { caller_id: "SCAM_050_01", caller_display: "070-0000-0000", caller_class: "voip070", is_whitelisted: false },
        { caller_id: "SCAM_UNKNOWN_01", caller_display: "발신번호표시제한", caller_class: "unknown", is_whitelisted: false },
    ];
}

function randDigits(rng: () => number, n: number) {
    let out = "";
    for (let i = 0; i < n; i++) out += String(Math.floor(rng() * 10));
    return out;
}
function make010(rng: () => number) {
    // 데모/코드공개 안전: 실번호처럼 보일 수 있는 랜덤 생성 금지
    if (false) rng();
    return `010-0000-0000`;
}
function make070(rng: () => number) {
    // 데모/코드공개 안전: 실번호처럼 보일 수 있는 랜덤 생성 금지
    if (false) rng();
    return `070-0000-0000`;
}
function normalizeCallerDisplay(
    rng: () => number,
    c: CallerRegistryEntry,
): CallerRegistryEntry {
    if (c.caller_class === "mobile") return { ...c, caller_display: make010(rng) };
    if (c.caller_class === "voip070") return { ...c, caller_display: make070(rng) };
    if (c.caller_class === "unknown") return { ...c, caller_display: `발신번호표시제한(${make010(rng)})` };
    return c; // official_landline 등은 그대로
}

function chooseCaller(rng: () => number, caseType: CaseType, isBenign: boolean): ScenarioInternal["caller"] {
    const reg = buildCallerRegistry();

    const spoofedOfficial = (caller_id: string): ScenarioInternal["caller"] => {
        const found = reg.find((x) => x.caller_id === caller_id) || reg[0];
        return {
            caller_id: found.caller_id,
            caller_display: found.caller_display,
            caller_class: "spoofed",
            is_whitelisted: true,
            is_first_seen: false,
        };
    };

    if (isBenign) {
        const c0 = pick(rng, reg.filter((x) => x.is_whitelisted));
        const c = normalizeCallerDisplay(rng, c0);
        return { ...c, is_first_seen: false };
    }

    if (caseType.startsWith("bank_") || caseType === "account_takeover_cred") {
        if (chance(rng, 0.25)) return spoofedOfficial("OFFICIAL_BANK_MAIN");
        const pool0 = reg.filter((x) => !x.is_whitelisted && (x.caller_class === "voip070" || x.caller_class === "mobile" || x.caller_class === "unknown"));
        const c = normalizeCallerDisplay(rng, pick(rng, pool0));
        return { ...c, is_first_seen: true };
    }

    if (caseType === "go_bank_atm") {
        if (chance(rng, 0.3)) return spoofedOfficial("OFFICIAL_COURT_MAIN");
        const pool0 = reg.filter((x) => !x.is_whitelisted);
        const c = normalizeCallerDisplay(rng, pick(rng, pool0));
        return { ...c, is_first_seen: true };
    }

    const pool0 = reg.filter((x) => !x.is_whitelisted);
    const c = normalizeCallerDisplay(rng, pick(rng, pool0));
    return { ...c, is_first_seen: true };
}

// ---------- URL/QR (DEMO: 가상 "공식 URL 레지스트리" 기반) ----------
type UrlOwner = "bank" | "card" | "court" | "police" | "prosecutor" | "gov" | "delivery";

type UrlRegistryEntry = {
    url_id: string;
    owner: UrlOwner;
    url: string;
    host: string;
    label: string;
};

function buildUrlRegistry(): UrlRegistryEntry[] {
    return [
        { url_id: "OFFICIAL_BANK_LOGIN", owner: "bank", url: "https://portal-bank.invalid/secure/login", host: "portal-bank.invalid", label: "은행 포털 로그인" },
        { url_id: "OFFICIAL_BANK_VERIFY", owner: "bank", url: "https://portal-bank.invalid/secure/verify", host: "portal-bank.invalid", label: "은행 보안 확인" },
        { url_id: "OFFICIAL_CARD_AUTH", owner: "card", url: "https://card-center.invalid/auth/confirm", host: "card-center.invalid", label: "카드 본인확인" },

        { url_id: "OFFICIAL_COURT_NOTICE", owner: "court", url: "https://court-notice.invalid/case/view", host: "court-notice.invalid", label: "법원 사건 조회" },
        { url_id: "OFFICIAL_POLICE_HELP", owner: "police", url: "https://police-help.invalid/verify", host: "police-help.invalid", label: "경찰 확인 안내" },
        { url_id: "OFFICIAL_PROSECUTOR_HELP", owner: "prosecutor", url: "https://prosecutor-help.invalid/verify", host: "prosecutor-help.invalid", label: "검찰 확인 안내" },
        { url_id: "OFFICIAL_GOV_PAY", owner: "gov", url: "https://tax-refund.invalid/pay/check", host: "tax-refund.invalid", label: "납부/환급 확인" },

        { url_id: "OFFICIAL_DELIVERY_ADDR", owner: "delivery", url: "https://track-parcel.invalid/addr/confirm", host: "track-parcel.invalid", label: "배송지 확인" },
        { url_id: "OFFICIAL_DELIVERY_PICKUP", owner: "delivery", url: "https://track-parcel.invalid/pickup/check", host: "track-parcel.invalid", label: "보관/수령 확인" },
    ];
}

function ownersFromImpersonation(imp?: string): UrlOwner[] {
    switch (imp) {
        case "imp_bank": return ["bank", "card"];
        case "imp_court": return ["court"];
        case "imp_police": return ["police"];
        case "imp_gov": return ["gov"];
        case "imp_delivery": return ["delivery"];
        default: return ["bank", "card", "court", "police", "gov", "delivery"];
    }
}

function pickOfficialUrlEntry(rng: () => number, ownerChoices: UrlOwner[]): UrlRegistryEntry {
    const reg = buildUrlRegistry().filter(r => ownerChoices.includes(r.owner));
    return pick(rng, reg.length ? reg : buildUrlRegistry());
}

function typoHost(host: string, rng: () => number) {
    if (host.length < 8) return host;
    const mode = pick(rng, ["swap", "drop", "dup"] as const);
    const i = Math.floor(rng() * (host.length - 3)) + 1;
    if (mode === "swap") return host.slice(0, i) + host[i + 1] + host[i] + host.slice(i + 2);
    if (mode === "drop") return host.slice(0, i) + host.slice(i + 1);
    return host.slice(0, i) + host[i] + host.slice(i);
}

function homoglyphLiteHost(host: string, rng: () => number) {
    const rules: Array<[RegExp, string]> = [
        [/o/g, "0"],
        [/l/g, "1"],
        [/rn/g, "m"],
        [/vv/g, "w"],
    ];
    const [re, rep] = pick(rng, rules);
    if (!re.test(host)) return typoHost(host, rng);
    return host.replace(re, rep);
}

function makeVariantUrlFromOfficial(rng: () => number, official: UrlRegistryEntry, kind: UrlKind): string {
    if (kind === "official") return official.url;

    if (kind === "short") {
        const code = Math.floor(rng() * 90000 + 10000).toString(36).slice(0, 5);
        return `https://t.invalid/${code}`;
    }

    const u = new URL(official.url);
    if (kind === "typo") u.hostname = typoHost(u.hostname, rng);
    else if (kind === "homoglyph") u.hostname = homoglyphLiteHost(u.hostname, rng);
    return u.toString();
}

function hostOf(url: string) {
    try { return new URL(url).hostname; } catch { return ""; }
}
function urlMatchesRegistry(url: string, allowedHosts: string[]) {
    const h = hostOf(url);
    return !!h && allowedHosts.includes(h);
}

function makeQrLandingUrl(rng: () => number, kind: UrlKind, officialOwnerChoices: UrlOwner[]) {
    const official = pickOfficialUrlEntry(rng, officialOwnerChoices);
    const allowedHosts = Array.from(new Set(buildUrlRegistry().filter(r => officialOwnerChoices.includes(r.owner)).map(r => r.host)));
    const qr_url = makeVariantUrlFromOfficial(rng, official, kind);
    const match = urlMatchesRegistry(qr_url, allowedHosts);
    return { qr_url, match, allowedHosts, official_id: official.url_id };
}

// ---------- 텍스트 노이즈/어미 변형/동의어 ----------
type KoTone = "formal" | "polite" | "casual";

function pickTone(rng: () => number): KoTone {
    const r = rng();
    if (r < 0.4) return "polite";
    if (r < 0.8) return "formal";
    return "casual";
}

function applyNoiseKo(rng: () => number, s: string, level: "none" | "low" | "mid" | "high") {
    if (level === "none") return s;
    const p = level === "low" ? 0.12 : level === "mid" ? 0.2 : 0.32;
    let out = s;

    if (chance(rng, p)) out = out.replace(/해주세요/g, chance(rng, 0.5) ? "해 주세요" : "해주세 요");
    if (chance(rng, p * 0.8)) out = out.replace(/바로/g, chance(rng, 0.5) ? "바 로" : "바로 ");

    if (chance(rng, p)) out = out.replace(/입니다\./g, chance(rng, 0.5) ? "입니다요." : "입니다.");
    if (chance(rng, p)) out = out.replace(/하세요\./g, chance(rng, 0.5) ? "하세여." : "하세요.");

    if (chance(rng, p * 0.7)) out = out.replace(/확인/g, chance(rng, 0.5) ? "확닌" : "확잉");
    if (chance(rng, p * 0.6)) out = out.replace(/입금/g, chance(rng, 0.5) ? "입금요" : "입끔");

    return out;
}

function varyEnding(rng: () => number, base: string, tone: KoTone): string {
    // base는 “~합니다.” 형태를 권장. tone에 따라 가볍게 변환.
    if (!base.endsWith(".")) base = base + ".";
    if (tone === "formal") return base;

    const variantsPolite: Array<(s: string) => string> = [
        (s) => s.replace(/합니다\./g, "해 주세요."),
        (s) => s.replace(/합니다\./g, "부탁드립니다."),
        (s) => s.replace(/필요합니다\./g, "필요해요."),
        (s) => s.replace(/입니다\./g, "이에요."),
    ];
    const variantsCasual: Array<(s: string) => string> = [
        (s) => s.replace(/합니다\./g, "해요."),
        (s) => s.replace(/필요합니다\./g, "필요해요."),
        (s) => s.replace(/입니다\./g, "임."),
        (s) => s.replace(/부탁드립니다\./g, "부탁해요."),
    ];

    const fns = tone === "polite" ? variantsPolite : variantsCasual;
    return pick(rng, fns)(base);
}

function pickSyn(rng: () => number, xs: string[]) {
    return pick(rng, xs);
}

function renderAnchorLineSafe(
    rng: () => number,
    a: Anchor,
    tone: KoTone,
    urlStr?: string,
    vector?: Vector,
    urlKind?: UrlKind,
): string {
    const hasUrl = (s: string) => /https?:\/\/\S+/i.test(s);

    const addUrlHint = (s: string) => {
        if ((vector === "url" || vector === "qr") && (a === "A_LINK" || a === "A_QR") && urlKind) {
            if (urlKind === "short") s += ` (단축주소 short)`;
            if (urlKind === "typo") s += ` (오타/유사문자 typo)`;
            if (urlKind === "homoglyph") s += ` (유사치환 homoglyph)`;
        }
        if (hasUrl(s)) return s; // URL 포함 문장은 '.' 안 붙임
        return s.endsWith(".") ? s : s + ".";
    };

    const dummyBank = () => pick(rng, ["OO은행", "OO저축은행", "OO카드"] as const);
    const dummyName = () => pick(rng, ["홍길동", "김민수", "이서연", "박지훈"] as const);
    const dummyAcct = () => {
        const a = Math.floor(rng() * 900 + 100);
        const b = Math.floor(rng() * 90 + 10);
        const c = Math.floor(rng() * 900000 + 100000);
        return `${a}-${b}-${c}`;
    };

    if (ANCHOR_STYLE === "meta") {
        let base = "";
        if (a === "A_LINK") base = `링크 확인 유도가 포함됩니다: ${urlStr || "https://example.invalid/"}`;
        if (a === "A_QR") base = `QR 스캔 유도가 포함됩니다(랜딩): ${urlStr || "https://example.invalid/"}`;
        if (a === "A_OTP") base = `OTP(인증번호) 공유/전달을 요구하는 내용이 포함됩니다`;
        if (a === "A_INSTALL") base = `원격지원/지원앱 설치 유도가 포함됩니다 (remote / AnyDesk / TeamViewer)`;
        if (a === "A_TRANSFER")
            base = `송금/이체 유도가 포함됩니다: ${dummyBank()} 계좌번호 ${dummyAcct()} (예금주:${dummyName()})로 입금/송금(remit/wire)`;
        if (a === "A_GO_BANK") base = `은행/ATM 방문 및 현금 인출(withdraw/cash) 유도가 포함됩니다 (ATM)`;
        if (a === "A_CASH_PICKUP") base = `현금/퀵/대면 전달(cash pickup) 유도가 포함됩니다`;
        if (a === "A_TRAVEL") base = `이동/출국 유도가 포함됩니다`;
        if (a === "A_CRED") base = `로그인 정보 입력 유도가 포함됩니다${urlStr && vector === "url" ? `: ${urlStr}` : ""}`;
        if (a === "A_PII") base = `개인정보 제공 유도가 포함됩니다${urlStr && vector === "url" ? `: ${urlStr}` : ""}`;
        return varyEnding(rng, addUrlHint(base), tone);
    }

    let out = "";
    if (a === "A_LINK") out = `아래 링크 확인해 주세요: ${urlStr || "https://example.invalid/"}`;
    if (a === "A_QR") out = `QR 찍고 접속해 주세요: ${urlStr || "https://example.invalid/"}`;

    // ✅ "번호 주세요"는 demand(알려/입력/전달) 정규식에 안 걸릴 수 있어, 엔진/라벨 정합을 위해 표현을 고정
    if (a === "A_OTP") out = `OTP(인증번호) 알려주세요`;

    if (a === "A_INSTALL") out = `원격지원 앱(TeamViewer/AnyDesk) 설치해 주세요 (remote)`;
    if (a === "A_TRANSFER")
        out = `${dummyBank()} 계좌번호 ${dummyAcct()} (예금주:${dummyName()})로 지금 입금/송금(remit/wire)해 주세요`;
    if (a === "A_GO_BANK") out = `지금 ATM으로 가서 현금 인출(withdraw/cash) 후 연락해 주세요 (ATM)`;
    if (a === "A_CASH_PICKUP") out = `현금 봉투 준비해서 퀵/대면(cash pickup)으로 전달해 주세요`;
    if (a === "A_TRAVEL") out = `출국 가능하시면 공항 쪽으로 이동해 주세요`;
    if (a === "A_CRED") out = `아이디/비밀번호 입력해 주세요${urlStr && vector === "url" ? `: ${urlStr}` : ""}`;
    if (a === "A_PII") out = `개인정보(신분증/계좌) 보내 주세요${urlStr && vector === "url" ? `: ${urlStr}` : ""}`;

    return addUrlHint(out);
}

// ---------- 스텁 기반 “핵심수법/유도방식” 추출(비중용이 아니라 생성 파라미터/문구 선택용) ----------
type StubFeatures = {
    hasOtp: boolean;
    hasRemote: boolean;
    hasTransfer: boolean;
    hasCash: boolean;
    hasTravel: boolean;
    hasBlackmail: boolean;
    hasPII: boolean;
    hasCred: boolean;
    hasUrl: boolean;
    hasQr: boolean;
    hasGoBank: boolean;       // ✅ 추가
    mentionsTypo: boolean;
    mentionsShort: boolean;
};

function deriveStubFeatures(stub: AnyObj): StubFeatures {
    const raw = `${stub.title || ""} ${stub.subject || ""} ${Array.isArray(stub.context_blocks) ? stub.context_blocks.join(" ") : ""} ${stub.body || ""}`.slice(0, 8000);
    const has = (re: RegExp) => re.test(raw);

    return {
        hasOtp: has(/인증번호|OTP|보안코드/i),
        hasRemote: has(/원격|teamviewer|팀뷰|anydesk|애니데스크|지원앱|앱\s*설치|설치/i),
        hasTransfer: has(/이체|송금|입금|계좌/i),
        hasCash: has(/현금|봉투|퀵|대면/i),
        hasTravel: has(/출국|항공|비행기|공항|여권|동남아|현지|취업/i),
        hasBlackmail: has(/유흥|업소|성매매|유포|협박|영상|폭로/i),
        hasPII: has(/주민|신분증|계좌번호|카드번호|개인정보/i),
        hasCred: has(/비밀번호|로그인|아이디/i),
        hasUrl: has(/https?:\/\/|www\./i),
        hasQr: has(/QR|큐알|큐싱/i),

        // ✅ 은행/ATM/창구 유도 힌트
        hasGoBank: has(/atm|은행\/?atm|현금인출|창구|은행으로|은행\s*가|방문/i),

        mentionsTypo: has(/타이포|오타|유사문자|비슷한\s*주소|도메인/i),
        mentionsShort: has(/단축|short|t\.|bit\.|tiny/i),
    };
}

function featuresToKeywords(f: StubFeatures): string[] {
    const out: string[] = [];
    if (f.hasOtp) out.push("otp");
    if (f.hasRemote) out.push("remote");
    if (f.hasTransfer) out.push("transfer");
    if (f.hasCash) out.push("cash");
    if (f.hasTravel) out.push("travel");
    if (f.hasBlackmail) out.push("blackmail");
    if (f.hasPII) out.push("pii");
    if (f.hasCred) out.push("cred");
    if (f.hasUrl) out.push("url");
    if (f.hasQr) out.push("qr");
    if (f.hasGoBank) out.push("go_bank");   // ✅ 추가
    if (f.mentionsTypo) out.push("typo");
    if (f.mentionsShort) out.push("short");
    return out;
}

function chooseUrlKindFromFeatures(rng: () => number, f: StubFeatures): UrlKind {
    if (f.mentionsShort) return "short";
    if (f.mentionsTypo) return chance(rng, 0.6) ? "typo" : "homoglyph";

    // ✅ 악성은 '공식' 비중을 낮추고 typo/homoglyph/short 중심으로
    const r = rng();
    if (r < 0.20) return "official";
    if (r < 0.55) return "typo";
    if (r < 0.80) return "homoglyph";
    return "short";
}

// ---------- 케이스 타입 결정(스텁 기반) ----------
function inferCaseTypeFromStub(rng: () => number, stub: AnyObj): CaseType {
    const text = `${stub.title || ""} ${stub.subject || ""} ${Array.isArray(stub.context_blocks) ? stub.context_blocks.join(" ") : ""} ${stub.body || ""}`
        .toLowerCase()
        .slice(0, 4000);

    const has = (re: RegExp) => re.test(text);

    if (has(/유흥|유포|협박|영상|폭로|불륜|성매매|업소/)) return "blackmail_sexvisit";
    if (has(/출국|항공|비행기|여권|현지|취업|동남아|캄보|라오|태국/)) return "job_travel";
    if (has(/택배|배송|운송장|부재|보관/)) return "delivery_link";
    if (has(/과태료|범칙금|미납|납부|환급/)) return "fine_refund_link";
    if (has(/원격|앱설치|설치|팀뷰|애니데|anydesk|지원앱/)) return "bank_install";
    if (has(/인증번호|otp|보안코드/)) return "bank_otp";
    if (has(/비밀번호|로그인|계정|인증\s*실패|잠금/)) return "account_takeover_cred";
    if (has(/주민|계좌|카드번호|신분증|개인정보/)) return "pii_collection";
    if (has(/대출|수수료|보증금|선입금/)) return "loan_fee";
    if (has(/atm|현금인출|은행으로|창구/)) return "go_bank_atm";
    if (has(/퀵|봉투|현금|직접\s*전달|대면/)) return "cash_pickup";

    const pool: CaseType[] = [
        "delivery_link",
        "fine_refund_link",
        "bank_otp",
        "bank_install",
        "account_takeover_cred",
        "pii_collection",
        "family_urgent_transfer",
        "loan_fee",
        "go_bank_atm",
        "cash_pickup",
        "job_travel",
        "blackmail_sexvisit",
    ];
    return pick(rng, pool);
}

// ---------- 케이스별 설정 ----------
function requiredAnchors(caseType: CaseType): Anchor[] {
    switch (caseType) {
        case "delivery_link":
        case "fine_refund_link":
            return ["A_LINK"];
        case "bank_otp":
            return ["A_OTP"];
        case "bank_install":
            return ["A_INSTALL"];
        case "account_takeover_cred":
            return ["A_CRED"];
        case "pii_collection":
            return ["A_PII"];
        case "family_urgent_transfer":
            return ["A_TRANSFER"];
        case "loan_fee":
            return ["A_TRANSFER"];
        case "go_bank_atm":
            return ["A_GO_BANK"];
        case "cash_pickup":
            return ["A_CASH_PICKUP"];
        case "job_travel":
            return ["A_TRAVEL"];
        case "blackmail_sexvisit":
            return ["A_TRANSFER"];
        default:
            return ["A_TRANSFER"];
    }
}

function defaultVectorFor(caseType: CaseType): Vector {
    switch (caseType) {
        case "delivery_link":
        case "fine_refund_link":
        case "account_takeover_cred":
        case "pii_collection":
            return "url";
        default:
            return "none";
    }
}

function impersonationFor(caseType: CaseType): string | undefined {
    switch (caseType) {
        case "delivery_link":
            return "imp_delivery";
        case "fine_refund_link":
            return "imp_gov";
        case "bank_otp":
        case "bank_install":
        case "account_takeover_cred":
            return "imp_bank";
        case "go_bank_atm":
            return "imp_court";
        default:
            return undefined;
    }
}

function pressuresFor(rng: () => number, caseType: CaseType): string[] {
    switch (caseType) {
        case "blackmail_sexvisit":
            return ["press_threat", "press_secrecy", "press_urgent"];

        case "family_urgent_transfer":
            return ["press_urgent", "press_secrecy"];

        case "bank_install":
        case "bank_otp":
        case "loan_fee":
            return ["press_urgent"];

        // ✅ ATM/현금전달은 보통 “지금 당장 + 외부에 말하지마”가 같이 붙음
        case "go_bank_atm":
        case "cash_pickup":
            return ["press_urgent", "press_secrecy"];

        // 링크형도 너무 “평문 안내”면 낮게 나올 수 있어 가끔 급한 톤을 줌
        case "delivery_link":
        case "fine_refund_link":
            return chance(rng, 0.5) ? ["press_urgent"] : [];

        default:
            return [];
    }
}

function stageFromAnchors(
    caseType: CaseType,
    anchors: Anchor[],
    vector: Vector,
    urlKind: UrlKind | undefined,
    urlMatch: boolean | undefined,
    pressures: string[],
    senderText: string
): Stage {
    // ✅ 엔진(scoreThread)처럼 "rawThread 텍스트" 기준으로 stage를 산정
    // anchors는 생성 힌트일 뿐, 엔진은 anchors를 보지 않으므로 기대값도 텍스트에 맞춰야 stage mismatch가 줄어듦
    const t = String(senderText || "");

    const hasRemote =
        /(원격|원격\s*제어|팀뷰|teamviewer|anydesk|supremo|퀵서포트|quick\s*support)/i.test(t);

    const hasApk =
        /(apk|설치\s*파일|앱\s*설치|다운로드|파일\s*설치|프로그램\s*설치|업데이트\s*설치)/i.test(t);

    const hasInstallMention =
        /(설치|다운로드|앱\s*설치|원격\s*앱|원격\s*지원|지원\s*앱|뷰어\s*설치)/i.test(t);

    const hasPayRequest =
        /(계좌번호|예금주|입금|송금|이체|무통장|remit|wire|현금|인출|withdraw|cash|atm|창구|퀵|대면\s*전달|봉투|납부|지불|충전|선납|보험료|안내\s*계좌|보호\s*계좌|안전\s*계좌|지정\s*계좌)/i.test(
            t
        );

    const hasOtp = /(otp|인증번호|인증\s*코드|보안\s*코드)/i.test(t);

    const hasPersonal =
        /(비밀번호|비번|패스워드|계정|아이디|신분증|주민등록|여권|카드번호|cvv|cvc|보안카드|인증서|개인정보)/i.test(t);

    if (hasRemote || hasApk || hasInstallMention) return "install";
    if (hasPayRequest) return "payment";
    if (hasOtp || hasPersonal) return "verify";

    // 링크/QR은 엔진이 info로 두는 경우가 많아서 기본 info
    return "info";
}

function riskFromSignals(
    anchors: Anchor[],
    pressures: string[],
    impersonation?: string,
    vector?: Vector,
    urlKind?: UrlKind,
    urlMatch?: boolean,
    senderText?: string
): Risk {
    const rawThread = String(senderText || "");
    const ps = new Set((pressures || []).map((x) => String(x || "")));

    // ✅ 링크/QR 존재 여부는 "텍스트"로만 판단(anchors 힌트로 false positive 금지)
    const hasUrl = /https?:\/\/\S+|www\./i.test(rawThread);
    const hasQrCue = /(qr|큐알|QR\s*코드|스캔)/i.test(rawThread);
    const hasLink = hasUrl || hasQrCue;

    // 엔진(scoreThread)에서 hasLinkAny에 해당하는 느낌: URL/QR + 링크 언급 포함
    const hasLinkAny = hasLink || /(링크|url|주소|클릭|접속)/i.test(rawThread);

    // ✅ (확정 신호) URL 검증 결과가 "악성"이면 High 직행 가능 훅
    // - generator에서는 urlMatch=true를 "악성으로 확정"으로 취급
    const hasMaliciousUrl = urlMatch === true;

    const hasShortener =
        /(bit\.ly|t\.co|me2\.kr|tinyurl\.com|url\.kr|han\.gl|gg\.gg|vo\.la)/i.test(rawThread);

    const hasUrgent =
        ps.has("press_urgent") ||
        /(긴급|즉시|지금\s*바로|서둘러|재촉|기한|마감|지연\s*시|오늘\s*까지|금일\s*까지)/i.test(rawThread);

    const hasThreat =
        ps.has("press_threat") ||
        /(체포|구속|영장|압류|고소|기소|법적\s*조치|수사|출석\s*요구|계좌\s*정지|처벌)/i.test(rawThread);

    const isAuthorityImp =
        !!impersonation && /^imp_(gov|police|prosecutor|court|bank|card)/.test(impersonation);

    const hasAuthority =
        isAuthorityImp ||
        /(경찰|검찰|법원|금감원|금융감독원|국세청|관세청|수사관|검사|담당자|은행|카드사|고객센터)/i.test(rawThread);

    const hasDemand =
        /(보내\s*주|전달\s*해|입력\s*해|알려\s*주|회신|답장|제출|업로드|등록|확인\s*해\s*주)/i.test(rawThread);

    const hasPayRequest =
        /(계좌번호|예금주|입금|송금|이체|무통장|remit|wire|현금|인출|withdraw|cash|atm|창구|퀵|대면\s*전달|봉투)/i.test(
            rawThread
        );

    const hasExplicitPayWord =
        /(납부|지불|결제|충전|선납|보험료|안내\s*계좌|보호\s*계좌|안전\s*계좌|지정\s*계좌)/i.test(rawThread);

    const hasTransfer = /(송금|이체|입금|remit|wire)/i.test(rawThread);
    const hasTransferDemand =
        /(송금\s*해|이체\s*해|입금\s*해|보내\s*주|보내\s*줘|송금\s*요청|이체\s*요청|입금\s*요청)/i.test(rawThread);

    const hasCashPickup =
        /(퀵|봉투|현금\s*(수거|전달)|직접\s*전달|대면\s*전달|현금\s*전달|현금\s*수거)/i.test(rawThread);

    const hasVisitPlace =
        /(은행으로|은행\s*가서|가까운\s*은행|창구|atm|ATM|지점|방문|오시|오셔|가세요|이동)/i.test(rawThread);

    const hasContactMove =
        /(오픈채팅|오픈\s*채팅|카톡|카카오톡|텔레그램|텔레|라인|DM|쪽지|톡방|단톡|채팅방|메신저)/i.test(rawThread);

    const hasOtp = /(otp|인증번호|인증\s*코드|보안\s*코드)/i.test(rawThread);

    const hasRemote =
        /(원격|원격\s*제어|팀뷰|teamviewer|anydesk|supremo|퀵서포트|quick\s*support)/i.test(rawThread);

    const hasApk =
        /(apk|설치\s*파일|앱\s*설치|다운로드|파일\s*설치|프로그램\s*설치|업데이트\s*설치)/i.test(rawThread);

    const hasInstallMention =
        /(설치|다운로드|앱\s*설치|원격\s*앱|원격\s*지원|지원\s*앱|뷰어\s*설치)/i.test(rawThread);

    const hasJobScam =
        /(구인|채용|공고|지원|알바|일자리|업무|면접|현지\s*근무|고수익|톡방|오픈채팅|동남아)/i.test(rawThread);

    const hasJobHook = /(고수익|부업|재택|알바|구인|채용)/i.test(rawThread);

    const hasJobPiiRequest =
        /(신분증|여권|주민등록|사진|업로드|올려|제출|전달)/i.test(rawThread);

    const hasInvest =
        /(투자|코인|가상자산|주식|선물|마진|리딩방|수익률|원금\s*보장|고수익\s*확정)/i.test(rawThread);

    const hasFamily =
        /(아들|딸|엄마|아빠|가족|지인|친구).*?(사고|납치|급전|합의금|병원|경찰서)/i.test(rawThread);

    const hasPersonal =
        /(개인정보|비밀번호|비번|패스워드|계정|아이디|신분증|주민등록|여권|카드번호|cvv|cvc|보안카드|인증서)/i.test(
            rawThread
        );

    const hasTxnAlert =
        /(승인|결제\s*승인|출금|입금|자동이체|로그인\s*시도\s*감지|접속\s*시도\s*감지|보안\s*알림|거래\s*알림)/i.test(
            rawThread
        );

    const financeLike = /(카드|은행|계좌|승인|결제|정지|해지|분실|도난)/i.test(rawThread);

    // scoreThread의 hasOtpFinance 근사(OTP + 금융/알림)
    const hasOtpFinance = hasOtp && (financeLike || hasTxnAlert);

    // scoreThread의 hasPiiRequest 근사
    const hasPiiRequest = hasPersonal;

    // "benign support" 류(발신자가 경고/검증/안전 안내를 주는 경우) — high 오탐 방지용
    const benignSupport =
        /(피싱|스미싱|주의|절대\s*누르|공식\s*번호|고객센터로\s*확인|직접\s*확인)/i.test(rawThread);

    // ---------- scoreThread hardHigh 구조를 텍스트 기반으로 근사 ----------
    // ✅ 단서 카운트(앵커(linkAny)는 단서로 치지 않음)
    //    - 앵커 + 귀결행동만: Medium
    //    - 단서(권위/협박/압박/요구/알림/연락처이동/OTP-금융 등) 1개 이상: High 후보
    const clueCount = [
        hasAuthority,
        hasThreat,
        hasUrgent,
        hasTxnAlert,
        hasDemand,
        hasContactMove,
        hasOtpFinance,
    ].filter((x) => !!x).length;

    // 구조적 High 후보들(여기서 authority/threat/urgent는 “증폭기”)
    // ✅ 링크(앵커) + 설치/원격(귀결행동)만으로는 High 금지 → 단서 추가 필요
    const installHigh = hasLinkAny && (hasRemote || hasApk || hasInstallMention) && clueCount >= 1 && !benignSupport;

    const investHigh =
        hasInvest &&
        (hasLinkAny || hasContactMove) &&
        (hasInstallMention || hasApk || hasPayRequest || hasTransferDemand || hasUrgent || hasThreat || hasAuthority) &&
        !benignSupport;

    const otpAuthorityHigh =
        hasOtp && hasDemand && (hasThreat || hasAuthority || hasTxnAlert || hasOtpFinance) && !benignSupport;

    const otpLinkDemandHigh = hasOtp && hasLinkAny && hasDemand && !benignSupport;

    const familyHigh =
        hasFamily && (hasPayRequest || hasExplicitPayWord || hasUrgent || hasTransferDemand || hasTransfer) && !benignSupport;

    const jobPiiHigh = hasLinkAny && hasJobScam && (hasJobPiiRequest || hasPiiRequest) && !benignSupport;

    // (신규) 이체/송금 지시: 앵커+귀결행동만이면 Medium, 단서 추가 시 High
    const transferDemandHigh = (hasTransferDemand || hasTransfer) && clueCount >= 1 && !benignSupport;

    // (신규) 현금 수거/퀵 전달은 매우 강함
    const cashPickupHigh =
        hasCashPickup &&
        (hasAuthority || hasThreat || hasUrgent || hasDemand || hasLinkAny || hasContactMove) &&
        !benignSupport;

    // 결제/이체: 앵커+귀결행동만이면 Medium, 단서 추가 시 High
    const payHigh = (hasPayRequest || hasExplicitPayWord || hasTransfer) && clueCount >= 1 && !benignSupport;

    const visitHigh =
        hasVisitPlace &&
        (hasJobHook || hasJobScam || hasInvest) &&
        (hasContactMove || hasLinkAny) &&
        (hasCashPickup || hasTransferDemand || hasPayRequest || hasTransfer) &&
        !benignSupport;

    const jobHigh =
        (hasJobHook || hasJobScam) &&
        (hasContactMove || hasLinkAny) &&
        (hasVisitPlace || hasPayRequest || hasTransferDemand || hasTransfer || hasCashPickup) &&
        !benignSupport;

    // ✅ 코어 액션(진행 단계의 핵): 이 중 하나라도 있어야 High 후보가 됨
    const hasCoreAction =
        (hasRemote ||
            hasApk ||
            hasInstallMention ||
            hasOtp ||
            hasOtpFinance ||
            hasPayRequest ||
            hasTransfer ||
            hasTransferDemand ||
            hasCashPickup ||
            hasVisitPlace ||
            hasPiiRequest ||
            hasJobHook) &&
        !benignSupport;

    // ✅ hardHigh = (확정 신호) OR (코어 액션 전제 + 구조 매칭)
    const hardHigh =
        hasMaliciousUrl ||
        (hasCoreAction &&
            ((hasRemote && hasOtp) ||
                installHigh ||
                otpAuthorityHigh ||
                otpLinkDemandHigh ||
                familyHigh ||
                jobPiiHigh ||
                payHigh ||
                investHigh ||
                visitHigh ||
                transferDemandHigh ||
                cashPickupHigh ||
                jobHigh ||
                (hasJobScam && !benignSupport)));

    // ✅ 정책: high는 hardHigh에서만
    let risk: Risk;

    if (hardHigh) risk = "high";
    else {
        // scoreThread의 toRiskLevel(scoreTotal, hardHigh) 근사:
        // hardHigh=false 이면 score >= 35 => medium, else low
        let score = 0;

        // link / shortener
        if (hasLinkAny) score += hasShortener ? 30 : 25;

        // install/remote
        if (hasRemote || hasApk || hasInstallMention) score += 28;

        // otp / pii
        if (hasOtp) score += 22;
        if (hasPersonal) score += 20;

        // money-like
        if (hasPayRequest || hasExplicitPayWord || hasTransfer) score += 18;

        // pressure/authority/threat
        if (hasUrgent) score += 10;
        if (hasAuthority) score += 10;
        if (hasThreat) score += 14;

        // lures
        if (hasInvest) score += 10;
        if (hasJobScam) score += 20;

        score = Math.min(100, score);

        risk = score >= 35 ? ("medium" as Risk) : ("low" as Risk);
    }

    // scoreThread: 원격/설치만(금융/OTP/협박 없이) high 금지 (biz doc lure 예외)
    const bizDocLure =
        /(세금계산서|거래처|회계팀|인보이스|invoice|견적서|발주서|계약서|정산|반려|수정본|문서\s*(뷰어|viewer)|열람)/i.test(rawThread);

    const remoteOnlyHighLike =
        risk === ("high" as Risk) &&
        (hasRemote || hasInstallMention) &&
        !bizDocLure &&
        !hasExplicitPayWord &&
        !hasOtp &&
        !hasThreat &&
        !hasAuthority &&
        !hasUrgent &&
        !hasApk &&
        !hasJobScam &&
        !hasInvest &&
        !hasFamily &&
        !benignSupport;

    if (remoteOnlyHighLike) risk = "medium" as Risk;

    return risk;
}

function triggersFrom(
    caseType: CaseType,
    anchors: Anchor[],
    pressures: string[],
    impersonation?: string,
    vector?: Vector,
    urlKind?: UrlKind
) {
    const t: string[] = [];
    if (impersonation) t.push(impersonation);

    for (const a of anchors) {
        if (a === "A_LINK") t.push("act_link");
        if (a === "A_QR") t.push("act_qr_scan");
        if (a === "A_INSTALL") t.push("act_install", "act_remote");
        if (a === "A_OTP") t.push("act_otp_relay");
        if (a === "A_TRANSFER") t.push("act_transfer");
        if (a === "A_GO_BANK") t.push("act_go_bank");
        if (a === "A_CASH_PICKUP") t.push("act_cash_pickup");

        // ✅ 엔진 정합: job_lure ↔ ctx_job_hook 동기화
        if (a === "A_TRAVEL") t.push("job_lure", "ctx_job_hook");

        if (a === "A_CRED") t.push("req_credentials");
        if (a === "A_PII") t.push("req_personal");
    }

    for (const p of pressures) t.push(p);

    if (vector === "url") t.push("vector_url");
    if (vector === "qr") t.push("vector_qr");
    if (urlKind === "short") t.push("act_shortlink");
    if (urlKind === "typo") t.push("url_typo");
    if (urlKind === "homoglyph") t.push("url_homoglyph");

    // 케이스 라벨도 엔진쪽으로 최소 정렬(필요하면 추가 확장)
    if (caseType === "job_travel") t.push("job_lure", "ctx_job_hook");
    if (caseType === "blackmail_sexvisit") t.push("cat_blackmail");

    return uniqSorted(t);
}

// ---------- 대화 생성(방어/데모 톤, 어미/동의어/오타 다양화 포함) ----------
function buildConversation(
    rng: () => number,
    caseType: CaseType,
    anchors: Anchor[],
    vector: Vector,
    urlStr: string | undefined,
    urlKind: UrlKind | undefined,
    noiseLevel: "none" | "low" | "mid" | "high",
    maxLen: number,
    callerDisplay: string,
    stubKeywords: string[],
    pressures: string[],
    impersonation?: string,
): ScenarioTurn[] {
    const tone = pickTone(rng);

    const ORG = (() => {
        // ✅ 엔진이 실제로 잡기 쉬운 한국어 키워드 포함
        if (impersonation === "imp_bank") return pick(rng, ["OO은행", "OO카드", "금융감독원"] as const);
        if (impersonation === "imp_court") return pick(rng, ["OO지방법원", "법원"] as const);
        if (impersonation === "imp_police") return pick(rng, ["OO경찰서", "경찰"] as const);
        if (impersonation === "imp_gov") return pick(rng, ["국세청", "정부24", "행정기관"] as const);
        if (impersonation === "imp_delivery") return pick(rng, ["OO택배", "배송업체"] as const);

        // fallback
        if (caseType === "delivery_link") return pick(rng, ["OO택배", "배송업체"] as const);
        if (caseType.startsWith("bank_") || caseType === "account_takeover_cred") return pick(rng, ["OO은행", "금융감독원"] as const);
        if (caseType === "go_bank_atm") return pick(rng, ["OO지방법원", "검찰"] as const);
        return "기관";
    })();

    const pretextLines: string[] = [];
    const credLines: string[] = [];
    const pressureLines: string[] = [];
    const anchorLines: string[] = [];
    const followLines: string[] = [];

    const callerTag = callerDisplay ? `[발신 ${callerDisplay}] ` : "";

    // ✅ press_*가 실제 텍스트로 들어가야 prefilter/룰이 강하게 잡힘
    if (pressures.includes("press_urgent")) {
        pressureLines.push(applyNoiseKo(rng, varyEnding(rng, `긴급 안내입니다. 지금 바로 처리해야 합니다`, tone), noiseLevel));
    }
    if (pressures.includes("press_secrecy")) {
        pressureLines.push(applyNoiseKo(rng, varyEnding(rng, `보안상 외부 공유 금지입니다. 가족/지인에게도 말하지 마세요`, tone), noiseLevel));
    }
    if (pressures.includes("press_threat")) {
        pressureLines.push(applyNoiseKo(rng, varyEnding(rng, `미이행 시 계좌 정지/법적 조치가 진행될 수 있습니다`, tone), noiseLevel));
    }

    switch (caseType) {
        case "delivery_link":
            pretextLines.push(`${callerTag}${ORG} 안내입니다`);
            credLines.push(`배송지/보관 관련 확인이 필요합니다`);
            break;
        case "fine_refund_link":
            pretextLines.push(`${callerTag}${ORG} 안내입니다`);
            credLines.push(`미납/환급 관련 확인이 필요합니다`);
            break;
        case "bank_otp":
            pretextLines.push(`${callerTag}${ORG} 보안 안내입니다`);
            credLines.push(`본인 확인 절차가 필요합니다`);
            break;
        case "bank_install":
            pretextLines.push(`${callerTag}${ORG} 보안 점검 안내입니다`);
            credLines.push(`원격 지원 절차가 필요합니다`);
            break;
        case "account_takeover_cred":
            pretextLines.push(`${callerTag}${ORG} 계정 보안 안내입니다`);
            credLines.push(`로그인 차단 해제를 위해 확인이 필요합니다`);
            break;
        case "pii_collection":
            pretextLines.push(`${callerTag}${ORG} 확인 안내입니다`);
            credLines.push(`신분 확인을 위해 기초 정보 확인이 필요합니다`);
            break;
        case "family_urgent_transfer":
            pretextLines.push(`${callerTag}[가족] 긴급 상황입니다`);
            credLines.push(`지금 바로 확인이 필요합니다`);
            break;
        case "loan_fee":
            pretextLines.push(`${callerTag}${ORG} 심사 안내입니다`);
            credLines.push(`절차 진행을 위해 확인이 필요합니다`);
            break;
        case "go_bank_atm":
            pretextLines.push(`${callerTag}${ORG} 사건 처리 안내입니다`);
            credLines.push(`현장 확인 절차가 필요합니다`);
            break;
        case "cash_pickup":
            pretextLines.push(`${callerTag}${ORG} 처리 안내입니다`);
            credLines.push(`대면 전달 절차가 필요합니다`);
            break;
        case "job_travel":
            pretextLines.push(`${callerTag}해외 고수익 채용 안내입니다`);
            credLines.push(`출국/현지 근무 조건이며, 진행을 위해 본인 확인이 필요합니다`);
            break;
        case "blackmail_sexvisit":
            pretextLines.push(`${callerTag}협박 메시지입니다`);
            credLines.push(`시간 압박/비밀 강요 등이 포함됩니다`);
            break;
    }

    for (const a of anchors) {
        const line = renderAnchorLineSafe(rng, a, tone, urlStr, vector, urlKind);
        anchorLines.push(applyNoiseKo(rng, line, noiseLevel));
    }

    if (anchors.length === 0) {
        followLines.push(applyNoiseKo(rng, varyEnding(rng, `민감한 정보는 다른 채널로 전달하지 않는 방식이 안전합니다`, tone), noiseLevel));
        followLines.push(applyNoiseKo(rng, varyEnding(rng, `필요하면 대표번호로 직접 확인하는 방식이 안전합니다`, tone), noiseLevel));
    }

    const resistance = [
        `그런 건 왜 물어보시죠?`,
        `왜 그걸 확인해야 하나요?`,
        `내용이 이상한데요. 제가 직접 확인할게요.`,
        `대표번호로 확인하고 다시 연락드리겠습니다.`,
        `링크는 직접 검색해서 들어가겠습니다.`,
        `민감한 정보는 안내하기 어렵습니다.`,
        `지금은 진행하지 않겠습니다.`,
    ].map((s) => applyNoiseKo(rng, varyEnding(rng, s.endsWith(".") ? s : s + ".", tone), noiseLevel));

    const turns: ScenarioTurn[] = [];

    turns.push({ role: "S", text: applyNoiseKo(rng, varyEnding(rng, (pretextLines[0] || `${callerTag}${ORG} 안내입니다`) + ".", tone), noiseLevel) });
    turns.push({ role: "R", text: pick(rng, ["무슨 내용인가요?", "확인해볼게요.", "네."]) });
    turns.push({ role: "S", text: applyNoiseKo(rng, varyEnding(rng, (credLines[0] || `확인 절차가 필요합니다`) + ".", tone), noiseLevel) });

    // ✅ 예약: pressureLines + anchorLines + followLines는 절대 잘리지 않게
    const reserved = pressureLines.length + anchorLines.length + followLines.length;
    const hardMin = Math.min(20, 3 + Math.max(0, reserved));
    const capLen = Math.min(20, Math.max(maxLen, hardMin));

    const roomForOptional = Math.max(0, capLen - reserved);

    if (stubKeywords.length && turns.length + 1 <= roomForOptional) {
        turns.push({ role: "S", text: applyNoiseKo(rng, varyEnding(rng, `참고 키워드: ${stubKeywords.join(", ")}`, tone), noiseLevel) });
    }

    if (chance(rng, 0.4) && capLen >= 6 && turns.length + 2 <= roomForOptional) {
        turns.push({ role: "R", text: pick(rng, resistance) });

        const canHandoff = !!urlStr && (vector === "url" || vector === "qr");
        const handoffUrl = urlStr || "https://example.invalid/";
        const pressurePool = [
            "긴급 건입니다. 지금 바로 처리해 주세요.",
            "오늘 안으로 미처리 시 이용 제한될 수 있습니다. 즉시 확인 바랍니다.",
            "시간이 없습니다. 10분 내로 답변/확인 부탁드립니다.",
            ...(canHandoff ? [`확인 링크 보내드립니다: ${handoffUrl}`] : []),
        ];

        turns.push({
            role: "S",
            text: applyNoiseKo(rng, varyEnding(rng, pick(rng, pressurePool), tone), noiseLevel),
        });
    }

    const canSpikeLate = chance(rng, 0.55) && capLen >= 8;
    if (canSpikeLate) {
        const remainingForBuild = Math.max(0, roomForOptional - turns.length);
        const buildN = clampInt(Math.floor(rng() * 5) + 2, 0, Math.min(6, remainingForBuild));
        for (let i = 0; i < buildN; i++) {
            turns.push({
                role: i % 2 === 0 ? "S" : "R",
                text:
                    i % 2 === 0
                        ? applyNoiseKo(rng, varyEnding(rng, pick(rng, ["절차 안내입니다.", "확인이 필요합니다.", "기한이 있습니다."]), tone), noiseLevel)
                        : pick(rng, ["지금 해야 하나요?", "어떻게 하나요?", "왜요?"]),
            });
            if (turns.length >= roomForOptional) break;
        }
    }

    // ✅ 압박 → 앵커 → 후속 순서로 삽입
    for (const line of pressureLines) turns.push({ role: "S", text: line });
    for (const line of anchorLines) turns.push({ role: "S", text: line });
    for (const line of followLines) turns.push({ role: "S", text: line });

    while (turns.length < capLen && chance(rng, 0.35)) {
        turns.push({ role: "R", text: pick(rng, ["확인했습니다.", "이상한데요.", "진행 안 하겠습니다."]) });
        if (turns.length >= capLen) break;

        const canHandoff = !!urlStr && (vector === "url" || vector === "qr");
        const handoffUrl = urlStr || "";
        const followPool = [
            "추가 진행을 유도하는 내용이 포함됩니다.",
            "급하게 진행하라고 재촉하는 내용이 포함됩니다.",
            "다른 방식으로 확인하라고 안내하는 내용이 포함됩니다.",
            ...(canHandoff ? [`다른 채널로 안내하겠다며 링크를 전달하는 내용이 포함됩니다: ${handoffUrl}`] : []),
        ];

        turns.push({
            role: "S",
            text: applyNoiseKo(rng, varyEnding(rng, pick(rng, followPool), tone), noiseLevel),
        });

        if (turns.length >= capLen) break;
    }

    return turns.slice(0, capLen);
}

// ---------- 밸리데이터 ----------
function validateScenario(s: ScenarioInternal, isBenign: boolean): string[] {
    const errs: string[] = [];

    const urlCount = s.url?.count ?? 0;
    if (urlCount > 1) errs.push("url_count>1");

    if (!isBenign && (!s.anchors || s.anchors.length === 0)) errs.push("malicious_missing_anchor");

    const sTurns = s.turns.filter((t) => t.role === "S");
    if (sTurns.length < 2) errs.push("missing_pretext_or_cred");

    // ✅ 전화/메시지 타겟: 정상/비정상 모두 thread(특히 S)에 전화번호가 반드시 있어야 함
    const hasPhone = (x: string) => {
        const pat =
            /(?<!\d)(0(?:10|11|16|17|18|19)\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}|0(?:70|50)\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}|0(?:2|3\d|4\d|5\d|6\d)\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}|1(?:5|6|8)\d{2}\s*[-]?\s*\d{4})(?!\d)/;
        return pat.test(String(x || ""));
    };
    const sTextAll = sTurns.map((t) => String((t as any)?.text ?? "")).join("\n");
    const callerDisp = String((s as any)?.caller?.caller_display ?? "");
    if (!hasPhone(callerDisp) && !hasPhone(sTextAll)) errs.push("missing_phone");

    if (isBenign) {
        const bad = s.anchors.some((a) =>
            ["A_OTP", "A_INSTALL", "A_TRANSFER", "A_CRED", "A_PII", "A_CASH_PICKUP", "A_GO_BANK", "A_TRAVEL"].includes(a)
        );
        if (bad) errs.push("benign_has_danger_anchor");
    }

    if (!isBenign && s.caller.is_whitelisted) {
        if (s.expected.risk === "low") errs.push("whitelisted_malicious_should_not_be_low");
    }

    if (s.url && s.vector !== "url") errs.push("url_vector_mismatch");
    if (s.qr && s.vector !== "qr") errs.push("qr_vector_mismatch");

    return errs;
}

// ---------- 출력 스키마 어댑터 ----------
function turnsToThread(
    turns: { role: "S" | "R"; text: string }[],
    callerDisplay?: string
) {
    const phoneLike = (s: string) => {
        const t = String(s || "");
        return (
            /발신번호표시제한/.test(t) ||
            /(?<!\d)(0(?:10|11|16|17|18|19)\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}|0(?:2|3\d|4\d|5\d|6\d)\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}|0(?:70|50)\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}|1(?:5|6|8)\d{2}\s*[-]?\s*\d{4})(?!\d)/.test(t)
        );
    };

    const normRole = (raw: any, idx: number): "S" | "R" => {
        if (raw === "S" || raw === "sender") return "S";
        if (raw === "R" || raw === "receiver") return "R";
        return idx === 0 ? "S" : "R";
    };

    const lines = (turns || []).map((t: any, idx: number) => {
        const role = normRole(t?.role, idx);
        const text = String(t?.text ?? "").trim();
        return `${role}: ${text}`;
    });

    // ✅ callerDisplay가 있으면 "첫 S 라인"에만 (caller) 주입
    if (callerDisplay && String(callerDisplay).trim()) {
        const cd = String(callerDisplay).trim();
        let si = lines.findIndex((x) => /^S:\s*/.test(x));
        if (si < 0) {
            // S 라인이 아예 없으면 S 라인 하나 만들어서 앞에 둠
            lines.unshift(`S: (${cd})`);
            si = 0;
        }
        if (!phoneLike(lines[si])) {
            lines[si] = lines[si].replace(/^S:\s*/, `S: (${cd}) `);
        }
    }

    return lines.join("\n");
}

function lengthBucketFromTurns(n: number) {
    if (n <= 4) return "S";
    if (n <= 8) return "M";
    if (n <= 12) return "L";
    return "XL";
}

function toScenarioOutput(s: ScenarioInternal): AnyObj {
    const thread = turnsToThread(s.turns, (s as any)?.caller?.caller_display);

    const senderText =
        s.turns
            ?.filter((t) => t && (t as any).role === "S")
            ?.map((t) => String((t as any).text ?? ""))
            ?.join("\n")
            ?.trim() || "";

    // S 텍스트가 없으면 thread 전체로 폴백
    const effBasis = (senderText || "").trim() || String(thread || "");
    const t = String(effBasis || "");
    const t2 = t.replace(/\s+/g, "");

    const allAnchors: Anchor[] = Array.isArray((s as any).anchors) ? (s as any).anchors : [];
    let effAnchors = anchorsEffFromText(allAnchors, effBasis);

    // ---- 엔진과 최대한 비슷한 cue들(특히 payment/install 방어) ----
    const hasAmountKRW = (x: string) => /(\d{1,3}(?:,\d{3})+|\d+)\s*(원|만원)/.test(String(x || ""));

    const urlMatches = t.match(/https?:\/\/[^\s)]+|www\.[^\s)]+/gi) || [];
    const urlCount = urlMatches.length;
    const linkHits = Math.min(urlCount, 2);

    const qrCue = /(qr|큐알|QR\s*코드|스캔)/i.test(t);

    const otpCue =
        /(otp|인증번호|오티피|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|2fa|6\s*자리|6자리)/i.test(t);

    const installCue =
        /(teamviewer|anydesk|quicksupport|원격\s*지원|원격|remote|지원앱|apk|설치|install|다운로드|뷰어|viewer|플러그인|plugin)/i.test(t);

    const credCue =
        /(아이디|id\b|비밀번호|password|로그인\s*정보|계정\s*정보)/i.test(t) || /(아이디|비밀번호|로그인정보|계정정보)/i.test(t2);

    const travelCue =
        /(해외|출국|공항|현지\s*근무|고수익|채용|항공권|여권|비자|동남아)/i.test(t) ||
        /(해외|출국|공항|현지근무|고수익|채용|항공권|여권|비자|동남아)/i.test(t2);

    const piiStrongCue =
        /(주민등록|주민번호|신분증|여권|계좌\s*사본|카드번호)/i.test(t) || /(주민등록|주민번호|신분증|여권|계좌사본|카드번호)/i.test(t2);

    const piiCue =
        piiStrongCue ||
        /(개인정보|사진\s*업로드|업로드|제출)/i.test(t) ||
        /(개인정보|사진업로드|업로드|제출)/i.test(t2);

    const piiRequestCue =
        /(이름|성함|연락처|전화번호|휴대폰|생년월일|주민등록번호|주민번호|주소|우편번호|계좌번호|카드번호|비밀번호|패스워드|암호|신분증|여권)/i.test(t) &&
        /(알려|말해|남겨|적어|입력|작성|보내|제출|올려|전송|사진|캡처)/i.test(t);

    // scoreThread.ts의 paymentAlertOnly 필터와 동일 계열(결제 알림/설정 변경은 payment로 끌지 않음)
    const paymentAlertOnly =
        /(결제\s*알림|알림\s*설정|계좌\s*알림|설정\s*변경|설정이\s*변경|설정\s*확인|자동이체\s*등록|자동\s*이체\s*등록|다른\s*기기\s*로그인\s*시도\s*감지|로그인\s*시도\s*감지|접속\s*시도\s*감지)/i.test(
            t
        );

    const escrowLike = /(안전\s*결제|안전\s*거래|에스크로|escrow|거래)/i.test(t);

    const strongPayCue = /(입금|송금|이체|납부|지불|충전|선납|보험료)/i.test(t) || hasAmountKRW(t);

    const paymentVerb =
        /(보내\s*줘|보내줘|부쳐\s*줘|부쳐줘|입금\s*해|입금해|송금\s*해|송금해|이체\s*해|이체해|납부\s*해|납부해|지불\s*해|지불해|충전\s*해|충전해)/i.test(t) ||
        /(입금|송금|이체|납부|지불|충전|선납|보험료).{0,14}(해\s*줘|해줘|해\s*주|해주|해주세요|부탁|요청|하셔야|바랍니다|주시)/i.test(t) ||
        /(납부|지불|결제).{0,14}(하세요|바랍니다|필요|진행|처리|해주세요)/i.test(t) ||
        /(링크|페이지).{0,14}(에서|로).{0,12}(납부|결제|지불|송금|이체|입금)/i.test(t);

    const installBeforePay =
        /(설치).{0,10}(후|해야|필요).{0,24}(결제|납부|송금|이체|입금|진행)/i.test(t) ||
        /(결제|납부|송금|이체|입금).{0,18}(하려면|위해).{0,18}(설치)/i.test(t);

    const transferCue =
        effAnchors.includes("A_TRANSFER") ||
        /(안내\s*계좌|보호\s*계좌|안전\s*계좌|지정\s*계좌|계좌번호|예금주|무통장|입금|송금|이체|remit|wire)/i.test(t);

    const cashPickupCue =
        effAnchors.includes("A_CASH_PICKUP") ||
        (((/현금|cash/i.test(t) || /현금/.test(t2)) &&
            /(인출|현금\s*인출|현금\s*수령|withdraw|봉투|퀵|대면\s*전달|직접\s*전달|픽업|수거)/i.test(t)) as any);

    const goBankCue =
        effAnchors.includes("A_GO_BANK") ||
        ((/(은행|atm|창구)/i.test(t) || /(은행|atm|창구)/i.test(t2)) &&
            (/(방문|가서|가라|이동|찾아|인출|입금|송금|이체)/i.test(t) || /(방문|가서|가라|이동|찾아|인출|입금|송금|이체)/i.test(t2)));

    const ctxPayWithLinkCue =
        linkHits > 0 &&
        !paymentAlertOnly &&
        (/(링크|페이지|사이트).{0,18}(에서|로).{0,12}(납부|결제|지불|송금|이체|입금)/i.test(t) ||
            /(납부|결제|지불|송금|이체|입금).{0,18}(링크|페이지|사이트)/i.test(t)) &&
        (/(해\s*줘|해줘|해\s*주|해주|해주세요|하세요|하셔야|진행|처리|완료|부탁|요청|바랍니다)/i.test(t) || strongPayCue);

    // cue 없으면 anchor도 제거(과대 stage/risk 방지)
    if (!transferCue) effAnchors = effAnchors.filter((a) => a !== "A_TRANSFER");
    if (!cashPickupCue) effAnchors = effAnchors.filter((a) => a !== "A_CASH_PICKUP");
    if (!goBankCue) effAnchors = effAnchors.filter((a) => a !== "A_GO_BANK");

    // ---- scoreLike (디버그용) ----
    let scoreLike =
        25 * linkHits +
        (qrCue ? 25 : 0) +
        (otpCue ? 25 : 0) +
        (installCue ? 30 : 0) +
        (ctxPayWithLinkCue ? 22 : 0) +
        (transferCue ? 28 : 0) +
        (cashPickupCue ? 28 : 0) +
        (goBankCue ? 22 : 0) +
        (piiStrongCue ? 40 : piiCue ? 20 : 0) +
        (piiRequestCue ? 18 : 0) +
        (credCue ? 18 : 0) +
        (travelCue ? 22 : 0);

    if (scoreLike > 100) scoreLike = 100;

    // ✅ 출력 expected는 생성 시점의 s.expected(risk/stagePeak) 사용(중복 파생으로 mismatch 방지)
    const outRisk: Risk = ((s as any)?.expected?.risk as Risk) || "low";
    const outStagePeak: Stage = ((s as any)?.expected?.stagePeak as Stage) || "info";

    const scoreMin = outRisk === "high" ? 45 : outRisk === "medium" ? 25 : 0;

    // triggered: s.expected.triggers가 비어있으면 false(benign/hardneg 방어), 있으면 true
    const expectedTriggered = Array.isArray((s as any)?.expected?.triggers) ? (s as any).expected.triggers.length > 0 : outRisk !== "low";

    const notes = [
        s.impersonation ? String(s.impersonation) : "",
        ...(Array.isArray((s as any).pressures) ? (s as any).pressures.map(String) : []),
    ].filter(Boolean);

    const urgentPressuredHint = /(긴급|지금|즉시|당장|바로|오늘\s*안에|지연\s*시|미조치\s*시)/i.test(t);

    // callChecks (call 채널에서만 기본 생성)
    const callChecks =
        s.channel === "call"
            ? {
                otpAsked: otpCue,
                remoteAsked: installCue,
                urgentPressured: urgentPressuredHint,
                firstContact: Boolean((s as any)?.caller?.is_first_seen),
            }
            : undefined;

    // ---- policy_signals (UI/설명용; 엔진 정책과 분리) ----
    const expectedTriggers: string[] = Array.isArray((s as any)?.expected?.triggers)
        ? (s as any).expected.triggers.map(String)
        : [];

    const policyTokens = Array.from(new Set([...expectedTriggers, ...notes.map(String)]));

    const badgeSet = new Set<string>();

    const hasImp = expectedTriggers.some((x) => x.startsWith("imp_")) || Boolean(s.impersonation);

    const hasLinkOrQr =
        expectedTriggers.some((x) =>
            [
                "act_link",
                "vector_url",
                "url_typo",
                "url_homoglyph",
                "act_shortlink",
                "vector_qr",
                "act_qr_scan",
            ].includes(x)
        ) || linkHits > 0 || qrCue;

    const hasPiiOrCred =
        expectedTriggers.some((x) => ["req_credentials", "req_personal"].includes(x)) ||
        piiCue ||
        credCue ||
        piiRequestCue;

    const hasPressure = expectedTriggers.some((x) => x.startsWith("press_")) || urgentPressuredHint;

    const hasMoneyAction =
        expectedTriggers.some((x) => ["act_transfer", "act_go_bank", "act_cash_pickup"].includes(x)) ||
        transferCue ||
        goBankCue ||
        cashPickupCue ||
        ctxPayWithLinkCue ||
        paymentVerb ||
        strongPayCue;

    const hasInstallOrRemote =
        expectedTriggers.some((x) => ["act_install", "act_remote"].includes(x)) || installCue;

    const hasOtp = expectedTriggers.some((x) => x === "act_otp_relay") || otpCue;

    const hasJobLure = expectedTriggers.includes("job_lure");
    const hasBlackmail = expectedTriggers.includes("cat_blackmail");

    if (hasImp) badgeSet.add("impersonation");
    if (hasLinkOrQr) badgeSet.add("link_or_qr");
    if (hasPiiOrCred) badgeSet.add("pii_or_credentials");
    if (hasPressure) badgeSet.add("pressure");
    if (hasMoneyAction) badgeSet.add("money_action");
    if (hasInstallOrRemote) badgeSet.add("install_or_remote");
    if (hasOtp) badgeSet.add("otp");
    if (hasJobLure) badgeSet.add("job_lure");
    if (hasBlackmail) badgeSet.add("blackmail");

    const policyBadges = Array.from(badgeSet.values());

    return {
        id: s.id,
        category: s.caseType,
        label: outRisk,
        length_bucket: lengthBucketFromTurns(s.turns.length),
        thread,

        ...(callChecks ? { callChecks } : {}),

        expected: {
            riskLevel: outRisk,
            score_min: scoreMin,
            stagePeak: outStagePeak,
            triggered: expectedTriggered,
        },

        // 기존 필드 유지(리포트/디버그용) + 엔진 ctx alias 보강
        should_trigger: uniqSorted([
            ...(((s as any)?.expected?.triggers) || []),
            ...(((s as any)?.expected?.triggers || []).includes("job_lure") ? ["ctx_job_hook"] : []),
        ]),

        notes,

        meta: {
            ...(s.meta || {}),
            eff_basis: effBasis.slice(0, 4000),
            eff_anchors: effAnchors,

            policy_signals: {
                tokens: policyTokens,
                badges: policyBadges,
            },

            scoreLike,
            cues: {
                linkHits,
                qrCue,
                otpCue,
                installCue,
                transferCue,
                cashPickupCue,
                goBankCue,
                ctxPayWithLinkCue,
                paymentAlertOnly,
                escrowLike,
                strongPayCue,
                installBeforePay,
                paymentVerb,
            },
        },
    };
}

async function readJsonl(filePath: string): Promise<AnyObj[]> {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const out: AnyObj[] = [];
    for (const line of lines) {
        try {
            out.push(JSON.parse(line));
        } catch {
            // skip bad line
        }
    }
    return out;
}

async function writeJsonl(filePath: string, rows: AnyObj[]) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fs.writeFile(filePath, body, "utf8");
}

async function main() {
    const args = parseArgs(process.argv);
    ANCHOR_STYLE = args.anchor_style || "direct";
    const rng = mulberry32(args.seed);

    const stubs = await readJsonl(args.stubs);
    if (stubs.length === 0) throw new Error(`No stubs read from ${args.stubs}`);

    if (args.registry_out) {
        await writeJsonl(args.registry_out, buildCallerRegistry());
    }

    // ✅ 케이스 커버리지 강제: 처음 N개는 전체 케이스를 1회씩 반드시 포함(benign/hardneg 비활성)
    //    - inferCaseTypeFromStub()의 fallback pool과 동일한 목록을 사용
    const COVER_CASE_TYPES: CaseType[] = [
        "delivery_link",
        "fine_refund_link",
        "bank_otp",
        "bank_install",
        "account_takeover_cred",
        "pii_collection",
        "family_urgent_transfer",
        "loan_fee",
        "go_bank_atm",
        "cash_pickup",
        "job_travel",
        "blackmail_sexvisit",
    ];

    const outRows: AnyObj[] = [];
    let produced = 0;

    for (let i = 0; i < args.count; i++) {
        const stub = stubs[i % stubs.length];
        const baseType = inferCaseTypeFromStub(rng, stub);
        const stubFeat = deriveStubFeatures(stub);
        const stubKeywords = featuresToKeywords(stubFeat);

        const forceCover = i < COVER_CASE_TYPES.length;

        const isBenign = forceCover ? false : chance(rng, args.benign_ratio);
        const isHardNeg = forceCover ? false : (isBenign && chance(rng, args.hardneg_ratio));

        // ✅ benign은 "대화 기본문장"에서 위험 cue(원격/출국/ATM 등)가 나오지 않도록
        //    안전 케이스 타입으로 강제 (validator: benign_has_danger_anchor 방지)
        const benignCasePool: CaseType[] = ["delivery_link", "fine_refund_link", "loan_fee"];

        const caseType: CaseType = forceCover
            ? COVER_CASE_TYPES[i]
            : (isBenign ? pick(rng, benignCasePool) : baseType);

        // ✅ benign에서는 키워드 주입으로 위험 cue가 섞이지 않게(대화 생성용만)
        const stubKeywordsConv: string[] = isBenign ? [] : stubKeywords;

        // 길이 다양화: “핵심 유도 방식”이 있으면 더 길게(맥락형) 생성
        let lenProfile = pick(rng, ["short", "mid", "long"] as const);
        if (stubFeat.hasRemote || stubFeat.hasTransfer || stubFeat.hasBlackmail) lenProfile = "long";
        else if (stubFeat.hasOtp || stubFeat.hasPII || stubFeat.hasCred) lenProfile = chance(rng, 0.65) ? "mid" : lenProfile;

        const minLen = isBenign ? 1 : (lenProfile === "short" ? 4 : lenProfile === "mid" ? 7 : 13);
        const maxLenCap = lenProfile === "short" ? 6 : lenProfile === "mid" ? 12 : 20;
        const maxLen = clampInt(Math.floor(rng() * (maxLenCap - minLen + 1)) + minLen, minLen, maxLenCap);

        // 오타/어미/줄임말 데모를 위해 noise를 약간 더 적극적으로
        const noiseLevel: "none" | "low" | "mid" | "high" =
            ANCHOR_STYLE === "direct"
                ? "none"
                : chance(rng, 0.18) ? "none" : chance(rng, 0.45) ? "low" : chance(rng, 0.75) ? "mid" : "high";

        let attempt = 0;
        let bestErrs: string[] = [];

        while (attempt < args.max_retries) {
            attempt++;

            // ✅ benign은 should_trigger를 비워서 트리거 정합 깨짐 방지
            const impersonation = isBenign ? undefined : impersonationFor(caseType);
            const pressures = isBenign ? [] : pressuresFor(rng, caseType);

            // 계획(생성 힌트) 앵커: 대화 생성에만 사용
            let anchorsPlanned = isBenign ? ([] as Anchor[]) : requiredAnchors(caseType).slice();

            // 스텁 기반 “추가 유도” 보강(핵심수법/유도방식 반영): 과도하게 늘리지 않고 0~1개만 가끔 추가
            if (!isBenign) {
                const extra: Anchor[] = [];
                if (stubFeat.hasPII) extra.push("A_PII");
                if (stubFeat.hasCred) extra.push("A_CRED");
                if (stubFeat.hasGoBank) extra.push("A_GO_BANK");

                const filtered = extra.filter((x) => ["A_PII", "A_CRED", "A_GO_BANK"].includes(x));
                if (filtered.length && chance(rng, 0.35)) {
                    const pickOne = pick(rng, filtered);
                    if (!anchorsPlanned.includes(pickOne)) anchorsPlanned.push(pickOne);
                }
            }

            // vector: 수법에서 필요할 때만 + “분석 힌트 있으면 우선”, 없으면 소량 증강(augmented)
            let vector: Vector = isBenign ? "none" : defaultVectorFor(caseType);
            let augmentedVector = false;

            if (!isBenign) {
                if (stubFeat.hasQr && (caseType === "delivery_link" || caseType === "fine_refund_link")) {
                    vector = "qr";
                } else if (stubFeat.hasUrl && vector === "none") {
                    vector = "url";
                } else {
                    // 스텁에 없더라도 기능 데모를 위해 아주 소량만 추가(메타에 표시)
                    if ((caseType === "delivery_link" || caseType === "fine_refund_link") && chance(rng, 0.06)) {
                        vector = chance(rng, 0.5) ? "url" : "qr";
                        augmentedVector = true;
                    }
                }
            }

            // URL/QR 생성(0~1개, 원샷)
            let urlObj: ScenarioInternal["url"] | undefined;
            let qrObj: ScenarioInternal["qr"] | undefined;

            let urlKind: UrlKind | undefined;
            let urlStr: string | undefined;

            const ownerChoices = ownersFromImpersonation(impersonation);
            const allowedHosts = Array.from(new Set(buildUrlRegistry().filter(r => ownerChoices.includes(r.owner)).map(r => r.host)));

            if (!isBenign && vector === "url") {
                urlKind = chooseUrlKindFromFeatures(rng, stubFeat);
                const official = pickOfficialUrlEntry(rng, ownerChoices);
                const officialId = official.url_id;

                urlStr = makeVariantUrlFromOfficial(rng, official, urlKind);
                const match = urlMatchesRegistry(urlStr, allowedHosts);

                urlObj = { kind: urlKind, value: urlStr, count: 1, match, official_id: officialId };
            }

            if (!isBenign && vector === "qr") {
                urlKind = chooseUrlKindFromFeatures(rng, stubFeat);
                const qr = makeQrLandingUrl(rng, urlKind, ownerChoices);

                urlStr = qr.qr_url;
                const match = qr.match;

                qrObj = { target_kind: urlKind, note: `QR 스캔 유도(랜딩): ${urlStr}`, match, official_id: qr.official_id };

                if (!anchorsPlanned.includes("A_QR")) anchorsPlanned.push("A_QR");
                const idx = anchorsPlanned.indexOf("A_LINK");
                if (idx >= 0) anchorsPlanned.splice(idx, 1);
            }

            const caller = chooseCaller(rng, caseType, isBenign);

            const turns = buildConversation(
                rng,
                caseType,
                anchorsPlanned,
                vector,
                urlStr,
                urlKind,
                noiseLevel,
                maxLen,
                caller.caller_display,
                stubKeywordsConv,
                pressures,
                impersonation,
            );

            const senderText = turns
                .filter((t) => t.role === "S")
                .map((t) => t.text)
                .join(" ");

            const hasPayCue = /(계좌번호|예금주|입금|송금|이체|ATM|현금\s*인출|퀵|대면\s*전달|remit|wire|withdraw|cash)/i.test(senderText);
            const hasInstallCue = /(teamviewer|anydesk|원격|지원앱|앱\s*설치|설치|remote|apk)/i.test(senderText);

            // urlMatch 가져오기
            const urlMatch = (urlObj?.match ?? qrObj?.match) as (boolean | undefined);

            // ✅ pressures는 "텍스트에 실제로 존재" 기준으로 재구성해서 expected 과대/과소를 줄임
            const pressuresEff = (() => {
                const ps: string[] = [];

                // urgent: “급하게/서둘러/재촉” 같은 표현도 잡기
                if (/(긴급|즉시|지금\s*바로|바로\s*처리|급하게|서둘러|재촉|빨리\s*진행)/i.test(senderText)) {
                    ps.push("press_urgent");
                }

                // secrecy: “혼자만/절대/외부” 등 변형 포함
                if (/(공유\s*금지|보안상|비밀\s*유지|지인에게도\s*말하지|외부\s*유출|혼자만|절대\s*말하지)/i.test(senderText)) {
                    ps.push("press_secrecy");
                }

                // threat: “수사/검거/기소” 계열도 포함
                if (/(계좌\s*정지|법적\s*조치|체포|구속|영장|고소|처벌|벌금|동결|압수|수사|검거|기소)/i.test(senderText)) {
                    ps.push("press_threat");
                }

                return uniqSorted(ps);
            })();

            // ✅ eff anchors: “텍스트에 실제 cue가 존재하는 것만”으로 재구성(트리거/라벨 정합용)
            const allAnchors: Anchor[] = [
                "A_LINK",
                "A_QR",
                "A_OTP",
                "A_INSTALL",
                "A_TRANSFER",
                "A_CRED",
                "A_PII",
                "A_CASH_PICKUP",
                "A_GO_BANK",
                "A_TRAVEL",
            ];
            const anchorsEff = anchorsEffFromText(allAnchors, senderText);

            let stagePeak: Stage;
            if (isBenign) {
                stagePeak = "info";
            } else {
                stagePeak = stageFromAnchors(caseType, anchorsEff, vector, urlKind, urlMatch, pressuresEff, senderText);

                const hasTransferCue =
                    anchorsEff.includes("A_TRANSFER") ||
                    /(계좌번호|예금주|입금|송금|이체|무통장|remit|wire)/i.test(senderText);

                const hasCashCue =
                    anchorsEff.includes("A_CASH_PICKUP") ||
                    anchorsEff.includes("A_GO_BANK") ||
                    /(현금|인출|withdraw|cash|퀵|대면\s*전달|봉투|픽업|atm)/i.test(senderText);

                // payment인데 실제 "송금/현금" 근거가 없으면 verify로 방어
                if (stagePeak === "payment" && !(hasTransferCue || hasCashCue)) {
                    stagePeak = "verify";
                }

                // install인데 실제 설치 근거가 없으면 verify로 방어
                if (stagePeak === "install" && !(hasInstallCue || anchorsEff.includes("A_INSTALL"))) {
                    stagePeak = "verify";
                }

                // 링크/QR 방어:
                const hasUrlInText = /https?:\/\/\S+/i.test(senderText);
                const hasQrCue = /(qr|큐알|QR\s*코드|스캔)/i.test(senderText);

                if (vector === "url" && !hasUrlInText) stagePeak = "info";
                if (vector === "qr" && !(hasQrCue || hasUrlInText)) stagePeak = "info";

                // ✅ 엔진 정합: 링크/QR이 실제로 존재하면 stagePeak=info 금지(최소 verify)
                const hasLinkOrQrAnchor = hasUrlInText || hasQrCue || anchorsEff.includes("A_LINK") || anchorsEff.includes("A_QR");
                if (stagePeak === "info" && hasLinkOrQrAnchor) stagePeak = "verify";
            }

            const risk: Risk = isBenign
                ? "low"
                : riskFromSignals(anchorsEff, pressuresEff, impersonation, vector, urlKind, urlMatch, senderText);

            const triggers = triggersFrom(caseType, anchorsEff, pressuresEff, impersonation, vector, urlKind);

            const s: ScenarioInternal = {
                id: safeId(isBenign ? (isHardNeg ? "HN" : "BN") : "SC", i + 1),
                caseType,
                channel: pick(rng, ["sms", "call", "chat"] as Channel[]),
                caller,
                vector,
                url: urlObj,
                qr: qrObj,

                // ✅ 출력/검증은 eff anchors 기준(텍스트 기반)
                anchors: anchorsEff,

                // ✅ "실제 텍스트에 존재" 기준으로 저장(출력 notes/toScenarioOutput도 이 값을 씀)
                pressures: pressuresEff,

                impersonation,
                turns,
                expected: { risk, stagePeak, triggers },
                meta: {
                    stub_hint: String(stub.normalized_ref || stub.id || stub.url || stub.title || "").slice(0, 180),
                    stub_features: stubFeat,
                    stub_keywords: stubKeywords,
                    augmented_vector: augmentedVector,
                    noiseLevel,
                    attempt,

                    // (디버그용) 원본/유효 pressures 같이 보관
                    pressures_raw: pressures,
                    pressures_eff: pressuresEff,

                    // (디버그용) planned vs eff anchors 같이 보관
                    anchors_planned: anchorsPlanned,
                    anchors_eff: anchorsEff,
                },
            };

            const errs = validateScenario(s, isBenign);
            if (errs.length === 0) {
                outRows.push(toScenarioOutput(s));
                produced++;
                break;
            } else {
                bestErrs = errs;
            }
        }

        if (attempt >= args.max_retries) {
            // 마지막 시도에서 "성공"으로 outRows에 이미 추가된 경우(예: attempt==max_retries) FAIL을 추가로 넣지 않음
            const successId = safeId(isBenign ? (isHardNeg ? "HN" : "BN") : "SC", i + 1);
            const last = outRows[outRows.length - 1] as any;
            const lastId = last?.id;

            if (lastId !== successId) {
                outRows.push({
                    id: safeId("FAIL", i + 1),
                    error: "generator_failed_constraints",
                    errors: bestErrs,
                });
            }
        }
    }

    await writeJsonl(args.out, outRows);
    console.log(`[genScenariosFromStubs] wrote=${outRows.length} produced=${produced} out=${args.out}`);
    if (args.registry_out) console.log(`[genScenariosFromStubs] registry_out=${args.registry_out}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
