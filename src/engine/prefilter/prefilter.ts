/* src/engine/prefilter/prefilter.ts
   Lightweight prefilter / trigger engine (demo-oriented)
   - very cheap regex/url heuristics
   - scores strong+medium signals + combo bonuses
   - returns action: none | soft | auto
   - optional: displayText vs href mismatch (when provided)

   Update:
   - click(openUrl) 발생 시: "차단 + 검사(auto)"가 기본 정책이 되도록 점수/정책 오버라이드 추가
   - 은행 typosquat: suffix allowlist 기반 비교 + (allowlist 누락 대비) 브랜드 토큰 기반 label-유사도 비교 추가
   - 링크가 많은 스팸/광고 케이스: urlCount/uniqueHostCount 신호 추가
   - 리다이렉트 최대 5 hops 추적 helper(resolveRedirectChain) 제공(내부/백엔드에서 쓰는 용도)
*/

import { KR_BANK_HOST_SUFFIXES, KR_FI_EXTRA_HOST_SUFFIXES } from "./allowlists/krBankHosts";

export type PrefilterAction = "none" | "soft" | "auto";

export type PrefilterSignal = {
    id: string;
    label: string;
    points: number;
    matches?: string[];
    evidence?: string;
};

export type PrefilterResult = {
    score: number;
    action: PrefilterAction;
    thresholdSoft: number;
    thresholdAuto: number;
    signals: PrefilterSignal[];
    combos: PrefilterSignal[];
    trigIds: string[];
    window: {
        blocksConsidered: number;
        charsConsidered: number;
    };
};

export type LinkCandidate = {
    href: string; // 실제 이동 URL
    text?: string; // 사용자에게 보이는 텍스트(있으면)
};

export type RedirectResolveResult = {
    startUrl: string;
    chain: string[]; // 방문한 URL들(정규화된 문자열)
    finalUrl: string;
    hops: number;
    statusChain?: number[];
    error?: string;
};

export type PrefilterContext = {
    // “등록된/저장된 번호가 아님” 같은 외부 컨텍스트는 UI/플랫폼에서 넣어줘야 함
    isSavedContact?: boolean; // false면 더 위험
    explicitActions?: {
        copyUrl?: number; // URL 복사 시도
        openUrl?: number; // URL 열기 시도 (== 클릭/열기 시도)
        installClick?: number; // 설치/앱다운 버튼/문구 클릭
    };
    linkCandidates?: LinkCandidate[]; // 표시텍스트≠실링크 탐지용(있을 때만)

    // (선택) 클릭 전에/직후에 내부에서 리다이렉트 체인을 따라가 본 결과를 넣어줄 수 있음
    // UI가 이 값을 주면, prefilter 결과 카드에서 "최종 목적지" 힌트를 보여주기 쉬움(점수에도 반영 가능)
    resolved?: RedirectResolveResult;
};

export type PrefilterOptions = {
    // how many recent blocks(lines) to consider (real-time feed에서는 최근 N만 보게끔)
    recentBlocksMax?: number;

    // thresholds
    thresholdSoft?: number; // show “의심” UI (quiet)
    thresholdAuto?: number; // auto-run full analysis

    // benign allowlist host suffixes (optional)
    allowHosts?: string[];

    // bank-like allowlist host suffixes (optional)
    bankHosts?: string[];
    extraFiHosts?: string[];

    // redirect-follow helper defaults (optional)
    maxRedirectHops?: number; // default 5
    redirectTimeoutMs?: number; // default 2500

    // external context (optional)
    context?: PrefilterContext;

    // debug (optional)
    debug?: boolean; // prefilter 내부 신호 로그 출력
};

const DEFAULT_SOFT = 28;
const DEFAULT_AUTO = 52;
const DEFAULT_RECENT_BLOCKS = 16;

const DEFAULT_MAX_REDIRECT_HOPS = 5;
const DEFAULT_REDIRECT_TIMEOUT_MS = 2500;

const SHORTENER_HOSTS = new Set([
    "t.co",
    "bit.ly",
    "tinyurl.com",
    "goo.gl",
    "rebrand.ly",
    "cutt.ly",
    "is.gd",
    "vo.la",
    "me2.do",
    "han.gl",
]);

const DOWNLOAD_EXTS = [".apk", ".exe", ".msi", ".dmg", ".pkg", ".scr", ".bat", ".cmd", ".ps1", ".zip", ".rar", ".7z"];

const BANK_BRAND_TOKENS = [
    "kbstar",
    "wooribank",
    "shinhan",
    "kebhana",
    "hanabank",
    "ibk",
    "nonghyup",
    "nh",
    "sc",
    "citibank",
    "busanbank",
    "knbank",
    "imbank",
    "imbank", // (중복 있어도 무해)
    "dgb",
    "jbbank",
    "kjbank",
    "jejubank",
    "kakaobank",
    "tossbank",
    "kbanknow",
];

function normHost(h: string) {
    return (h || "").trim().toLowerCase().replace(/\.+$/, "");
}

function normalizeLabel(s: string) {
    return String(s || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9-]/g, "");
}

function hostBaseLabel(hostOrRoot: string) {
    const s = String(hostOrRoot || "").toLowerCase().trim();
    if (!s) return "";
    const first = s.split(".").filter(Boolean)[0] || "";
    return normalizeLabel(first);
}

function hostHasBrandToken(host: string): string | null {
    const h = normHost(host);
    if (!h) return null;

    const labels = h.split(".").filter(Boolean);
    const parts = labels.flatMap((l) => l.split("-").filter(Boolean));
    const set = new Set(parts);

    for (const tk0 of BANK_BRAND_TOKENS) {
        const tk = String(tk0 || "").trim().toLowerCase();
        if (!tk) continue;

        // 짧은 토큰(nh/sc/ibk 등)은 "라벨/하이픈 파트" 완전일치만 허용
        if (tk.length <= 3) {
            if (set.has(tk)) return tk;
            continue;
        }

        if (set.has(tk)) return tk;
        if (labels.some((l) => l.includes(tk))) return tk;
    }

    return null;
}

// 데모용 eTLD+1 근사(오탐 줄이기: path 무시, host만 본다)
function registrableDomain(host: string) {
    const h = normHost(host);
    const parts = h.split(".").filter(Boolean);
    if (parts.length <= 2) return h;

    const tail2 = parts.slice(-2).join(".");
    const tail3 = parts.slice(-3).join(".");
    // 한국에서 흔한 2단계 TLD들만 예외 처리
    if (/(^|\.)co\.kr$/.test(h) || /(^|\.)or\.kr$/.test(h) || /(^|\.)go\.kr$/.test(h) || /(^|\.)ac\.kr$/.test(h) || /(^|\.)ne\.kr$/.test(h)) {
        return tail3;
    }
    return tail2;
}

function editDistance(a: string, b: string) {
    const s = a || "";
    const t = b || "";
    const n = s.length;
    const m = t.length;
    if (!n) return m;
    if (!m) return n;

    const dp = new Array(m + 1);
    for (let j = 0; j <= m; j++) dp[j] = j;

    for (let i = 1; i <= n; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= m; j++) {
            const tmp = dp[j];
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            dp[j] = Math.min(
                dp[j] + 1, // del
                dp[j - 1] + 1, // ins
                prev + cost // sub
            );
            prev = tmp;
        }
    }
    return dp[m];
}

function isOfficialBySuffix(host: string, suffixes: string[]) {
    const h = normHost(host);
    return (suffixes || []).some((suf) => {
        const s = normHost(suf);
        return h === s || h.endsWith("." + s);
    });
}

function looksBankClaimContext(allText: string) {
    const s = (allText || "").toLowerCase();
    const a = /(은행|뱅크|bank|고객센터|인터넷\s*뱅킹|모바일\s*뱅킹|보안\s*카드|금융)/i.test(s);
    const b = /(로그인|인증|otp|오티피|보안|계좌|카드|이체|송금|결제)/i.test(s);
    return a && b;
}

const REDIRECT_PARAM_KEYS = ["url", "u", "r", "redirect", "redirect_url", "redirecturl", "return", "returnurl", "continue", "next", "target"];

function safeParseUrl(u: string): URL | null {
    try {
        return new URL(u);
    } catch {
        return null;
    }
}

function stripUrlTail(raw: string) {
    // 텍스트에서 URL 끝에 붙는 흔한 구두점 제거
    let s = (raw || "").trim();
    while (s.length > 0 && /[)\],.?!'"`}>]/.test(s[s.length - 1])) {
        s = s.slice(0, -1);
    }
    return s;
}

function normalizeToUrlString(raw: string) {
    let s = stripUrlTail(raw);
    if (!s) return "";

    // 흔한 난독화 복원(값싼 전처리)
    s = s
        .replace(/\b(hxxps?):\/\//gi, (_m, p1) => String(p1).toLowerCase().replace("hxxp", "http") + "://")
        .replace(/\b(https?|hxxps?)\s*\[:\]\s*\/\//gi, (_m, p1) => String(p1).toLowerCase().replace("hxxp", "http") + "://")
        .replace(/\b(https?|hxxps?)\s*:\s*\/\//gi, (_m, p1) => String(p1).toLowerCase().replace("hxxp", "http") + "://")
        .replace(/\[\.\]|\(\.\)|\{\.\}/g, ".")
        .replace(/&colon;/gi, ":")
        .replace(/&#58;/g, ":")
        .trim();

    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^www\./i.test(s)) return "https://" + s;

    // 스킴이 없는 "example.com/..." 류도 URL로 간주(난독화 매치에서만 넘어오도록 extract 단계에서 제한)
    if (/\.[a-z]{2,}([\/?#]|$)/i.test(s)) return "https://" + s;

    return s;
}

function extractUrlsLoose(text: string): string[] {
    const t = text || "";

    // 1) https://... / http://...
    const m1 = t.match(/https?:\/\/[^\s)]+/gi) || [];

    // 2) www. 도메인(스킴 없음)
    const m2 = t.match(/\bwww\.[^\s)]+/gi) || [];

    // 3) hxxp(s)://...
    const m3 = t.match(/\bhxxps?:\/\/[^\s)]+/gi) || [];

    // 4) http[:]//, https[:]//, hxxp[:]// 류
    const m4 = t.match(/\b(?:https?|hxxps?)\s*(?:\[:\]|:)\s*\/\/[^\s)]+/gi) || [];

    // 5) example[.]com/..., www[.]example[.]com/...
    const m5 = t.match(/\b[a-z0-9-]+(?:\[\.\]|\(\.\)|\{\.\})[a-z0-9-]+(?:\[\.\]|\(\.\)|\{\.\})?[a-z0-9.-]*[^\s)]+/gi) || [];

    // 6) ✅ 스킴/WWW 없는 “도메인 자체”도 URL로 간주 (gov24.go.kr, kbstar.com 등)
    //    - 너무 과하게 잡지 않도록: TLD는 문자 2~24, 옵션 path만 허용
    const m6 = t.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s)]*)?\b/gi) || [];

    const merged = [...m1, ...m2, ...m3, ...m4, ...m5, ...m6]
        .map((x) => normalizeToUrlString(x))
        .map(stripUrlTail)
        .filter(Boolean);

    return Array.from(new Set(merged)).slice(0, 12);
}

function extractMarkdownLinks(text: string): LinkCandidate[] {
    const t = text || "";
    const out: LinkCandidate[] = [];
    // [label](https://example.com/...)
    const re = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
        out.push({ text: (m[1] || "").trim(), href: stripUrlTail(m[2] || "") });
        if (out.length >= 10) break;
    }
    return out;
}

function normalizeBlocks(threadText: string, recentBlocksMax: number): string[] {
    const raw = String(threadText ?? "").replace(/\r\n/g, "\n").trim();
    if (!raw) return [];

    const lines = raw
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);

    return lines.length > recentBlocksMax ? lines.slice(lines.length - recentBlocksMax) : lines;
}

function hostMatchesAllow(host: string, allow: string) {
    const h = (host || "").toLowerCase();
    const a = (allow || "").toLowerCase();
    return h === a || h.endsWith("." + a);
}

function points(
    id: string,
    label: string,
    pts: number,
    evidenceOrMatches?: string | string[]
): PrefilterSignal {
    const stripPrefix = (x: string) => {
        let s = String(x || "").replace(/\r\n/g, "\n").trim();
        if (!s) return "";

        // 2026-02-03 09:12  /  2026.02.03 오전 9:12 같은 헤더가 있으면 제거
        s = s.replace(
            /^\s*(\d{4}[-./]\d{2}[-./]\d{2}[ T]\d{2}:\d{2}(?::\d{2})?|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s+(?:오전|오후)?\s*\d{1,2}:\d{2})\s*/i,
            ""
        );

        // S: / R: 프리픽스 제거
        s = s.replace(/^\s*(?:S|R)\s*:\s*/i, "");

        return s.trim();
    };

    const matchesRaw =
        evidenceOrMatches == null
            ? undefined
            : Array.isArray(evidenceOrMatches)
                ? evidenceOrMatches.filter(Boolean).map((m) => String(m))
                : [String(evidenceOrMatches)].filter(Boolean);

    const matches = matchesRaw
        ? matchesRaw
            .map((m) => stripPrefix(m))
            .filter(Boolean)
        : undefined;

    const evidence = matches && matches.length ? matches.join(" | ").trim() : undefined;

    return {
        id,
        label,
        points: pts,
        ...(matches && matches.length ? { matches } : {}),
        ...(evidence ? { evidence } : {}),
    };
}

function hasAny(re: RegExp, text: string) {
    return re.test(text);
}

function isPunycodeHost(host: string) {
    const h = (host || "").toLowerCase();
    return h.includes("xn--");
}

function countDots(host: string) {
    return (host || "").split(".").filter(Boolean).length - 1;
}

function hasRedirectParam(u: URL) {
    const sp = u.searchParams;
    for (const k of REDIRECT_PARAM_KEYS) {
        const v = sp.get(k);
        if (!v) continue;
        if (/https?:\/\//i.test(v) || /^www\./i.test(v)) return true;
    }
    return false;
}

function safeDecodeURIComponent(s: string) {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

// 네트워크 없이 “redirect 파라미터 안에 또 URL” 패턴만 최대 N번 추적
function extractRedirectParamChain(firstUrl: string, maxHops = 5): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    let current = normalizeToUrlString(firstUrl);
    for (let i = 0; i < maxHops; i++) {
        const norm = normalizeToUrlString(current);
        if (!norm) break;
        if (seen.has(norm)) break;
        seen.add(norm);
        out.push(norm);

        const u = safeParseUrl(norm);
        if (!u) break;

        let next = "";
        for (const k of REDIRECT_PARAM_KEYS) {
            const v0 = u.searchParams.get(k);
            if (!v0) continue;

            const v1 = safeDecodeURIComponent(String(v0 || "").trim());
            const vNorm = normalizeToUrlString(v1);
            if (!vNorm) continue;

            if (/^https?:\/\//i.test(vNorm) || /^www\./i.test(vNorm)) {
                next = vNorm;
                break;
            }
        }

        if (!next) break;
        current = next;
    }

    return out;
}

function extractDomainTokensFromText(s: string): string[] {
    const t = (s || "").toLowerCase();
    // 텍스트에서 보이는 도메인/호스트 토큰(대충)
    const m = t.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/g) || [];
    return Array.from(new Set(m)).slice(0, 6);
}

function looksLikeBankClaimText(s: string) {
    // “은행/고객센터/인뱅/인터넷뱅킹” + 로그인/인증류
    const t = (s || "").toLowerCase();
    const a = /(은행|뱅크|bank|고객센터|인터넷\s*뱅킹|모바일\s*뱅킹)/i.test(t);
    const b = /(로그인|인증|보안|otp|오티피|계좌|카드|이체|송금|결제)/i.test(t);
    return a && b;
}

/** 내부/백엔드에서 "최대 N번(기본 5)" 리다이렉트를 따라가 최종 URL을 얻는 helper */
export async function resolveRedirectChain(startUrlRaw: string, maxHops = DEFAULT_MAX_REDIRECT_HOPS, timeoutMs = DEFAULT_REDIRECT_TIMEOUT_MS): Promise<RedirectResolveResult> {
    const startUrl = normalizeToUrlString(startUrlRaw || "");
    const u0 = safeParseUrl(startUrl);
    if (!u0) {
        return { startUrl: startUrlRaw, chain: [], finalUrl: startUrlRaw, hops: 0, error: "INVALID_URL" };
    }
    if (!/^https?:$/i.test(u0.protocol || "")) {
        return { startUrl, chain: [startUrl], finalUrl: startUrl, hops: 0, error: "UNSUPPORTED_PROTOCOL" };
    }

    const blockedHost =
        /^(localhost|127\.|0\.0\.0\.0$)/i.test(u0.hostname || "") ||
        /^10\./.test(u0.hostname || "") ||
        /^192\.168\./.test(u0.hostname || "") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(u0.hostname || "");

    if (blockedHost) {
        return { startUrl, chain: [startUrl], finalUrl: startUrl, hops: 0, error: "BLOCKED_LOCAL_HOST" };
    }

    const seen = new Set<string>();
    const chain: string[] = [];
    const statusChain: number[] = [];

    let current = startUrl;
    for (let hop = 0; hop <= Math.max(0, Math.floor(maxHops)); hop++) {
        const curNorm = normalizeToUrlString(current);
        if (seen.has(curNorm)) {
            chain.push(curNorm);
            return { startUrl, chain, finalUrl: curNorm, hops: hop, statusChain, error: "REDIRECT_LOOP" };
        }
        seen.add(curNorm);
        chain.push(curNorm);

        const curUrl = safeParseUrl(curNorm);
        if (!curUrl) return { startUrl, chain, finalUrl: curNorm, hops: hop, statusChain, error: "INVALID_URL_IN_CHAIN" };

        const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ac ? setTimeout(() => ac.abort(), Math.max(300, timeoutMs)) : null;

        try {
            const f = (globalThis as any).fetch;
            if (typeof f !== "function") {
                return { startUrl, chain, finalUrl: curNorm, hops: hop, statusChain, error: "FETCH_UNAVAILABLE" };
            }

            // HEAD 우선, 안 되면 GET으로 폴백
            let res: Response | null = null;

            try {
                res = await f(curNorm, { method: "HEAD", redirect: "manual", signal: ac?.signal });
            } catch {
                res = null;
            }

            if (!res) {
                res = await f(curNorm, { method: "GET", redirect: "manual", signal: ac?.signal });
            }

            const st = (res as any)?.status ?? 0;
            statusChain.push(st);

            const loc = (res as any)?.headers?.get ? (res as any).headers.get("location") : null;
            if (st >= 300 && st < 400 && loc) {
                const next = safeParseUrl(loc) ? loc : new URL(loc, curUrl).toString();
                current = next;
                continue;
            }

            // 더 이상 리다이렉트 없음
            return { startUrl, chain, finalUrl: curNorm, hops: hop, statusChain };
        } catch (e: any) {
            const msg = String(e?.name || e?.message || "FETCH_ERROR");
            return { startUrl, chain, finalUrl: curNorm, hops: hop, statusChain, error: msg };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    return { startUrl, chain, finalUrl: chain[chain.length - 1] || startUrl, hops: maxHops, statusChain, error: "MAX_HOPS_REACHED" };
}

function scoreContextSignals(ctx?: PrefilterContext): PrefilterSignal[] {
    const out: PrefilterSignal[] = [];
    if (!ctx) return out;

    if (ctx.isSavedContact === false) {
        out.push(points("pf_unknown_contact", "저장되지 않은 번호/대화상대", 14));
    }

    const a = ctx.explicitActions || {};
    const copyN = Math.max(0, Math.floor(a.copyUrl ?? 0));
    const openN = Math.max(0, Math.floor(a.openUrl ?? 0));
    const instN = Math.max(0, Math.floor(a.installClick ?? 0));

    if (copyN > 0) out.push(points("pf_act_copy_url", "행동: URL 복사 시도", 16, [`x${copyN}`]));

    // openUrl은 "트리거(클릭 발생)" 표시용. 위험 점수는 URL 자체 신호로 판단한다.
    if (openN > 0) out.push(points("pf_act_open_url", "행동: URL 열기 시도", 0, [`x${openN}`]));

    if (instN > 0) out.push(points("pf_act_install_click", "행동: 설치/다운로드 클릭", 24, [`x${instN}`]));

    // (선택) 리다이렉트 추적 결과가 있으면 “최종 목적지”가 의심스러운지 힌트로 가점 가능
    const rr = ctx.resolved;
    if (rr?.finalUrl) {
        const fu = safeParseUrl(normalizeToUrlString(rr.finalUrl));
        if (fu) {
            const fh = normHost(fu.hostname || "");
            if (fh && (isPunycodeHost(fh) || countDots(fh) >= 4)) {
                out.push(points("pf_ctx_final_host_susp", "컨텍스트: 최종 목적지 호스트 의심", 12, [fh]));
            }
            if (rr.error && rr.error !== "MAX_HOPS_REACHED") {
                out.push(points("pf_ctx_resolve_error", "컨텍스트: 리다이렉트 추적 실패", 8, [rr.error]));
            }
            if (typeof rr.hops === "number" && rr.hops >= 3) {
                out.push(points("pf_ctx_many_redirects", "컨텍스트: 리다이렉트 단계 과다", 10, [`hops=${rr.hops}`]));
            }
        }
    }

    return out;
}

function scoreDisplayMismatchSignals(linkCandidates: LinkCandidate[], bankHosts: string[], extraFiHosts: string[]): PrefilterSignal[] {
    const out: PrefilterSignal[] = [];
    if (!Array.isArray(linkCandidates) || linkCandidates.length === 0) return out;

    const matches: string[] = [];

    const isOfficialSuffix = (h: string) => {
        const host = normHost(String(h || ""));
        return (
            (bankHosts || []).some((bh) => host === bh || host.endsWith("." + bh)) ||
            (extraFiHosts || []).some((bh) => host === bh || host.endsWith("." + bh))
        );
    };

    const tokenMatchesHost = (host: string, token: string) => {
        const h = normHost(host);
        const t = normHost(token);
        if (!h || !t) return false;

        if (h === t || h.endsWith("." + t) || t.endsWith("." + h)) return true;

        const hr = registrableDomain(h);
        const tr = registrableDomain(t);
        if (hr && tr && hr === tr) return true;

        return false;
    };

    for (const lc of linkCandidates.slice(0, 10)) {
        const hrefNorm = normalizeToUrlString(lc.href || "");
        const u = safeParseUrl(hrefNorm);
        if (!u) continue;

        const host = (u.hostname || "").toLowerCase();
        const text = (lc.text || "").trim();
        if (!text) continue;

        const tokens = extractDomainTokensFromText(text).slice(0, 4);
        if (tokens.length === 0) continue;

        const anyEq = tokens.some((tok) => tokenMatchesHost(host, tok));
        if (!anyEq) {
            matches.push(`${tokens[0]} → ${host}`);
        }

        const textBankish = tokens.some((tok) => isOfficialSuffix(tok));
        const hostIsOfficial = isOfficialSuffix(host);

        if (textBankish && !hostIsOfficial) {
            matches.push(`(bank-text) ${tokens[0]} → ${host}`);
        }
    }

    if (matches.length > 0) {
        out.push(points("pf_url_display_mismatch", "표시 링크 ≠ 실제 링크 의심", 34, matches));
    }

    return out;
}

function scoreUrlSignals(allText: string, urls: string[], allowHosts: string[], bankHosts: string[], extraFiHosts: string[]): PrefilterSignal[] {
    const out: PrefilterSignal[] = [];
    const allow = allowHosts || [];

    const officialSuffixes = Array.from(new Set([...(bankHosts || []), ...(extraFiHosts || [])].map((x) => String(x || "").trim()).filter(Boolean)));

    let httpCount = 0;
    let shortCount = 0;
    let downloadCount = 0;
    let ipHostCount = 0;
    let punyCount = 0;
    let deepSubCount = 0;
    let redirectParamCount = 0;

    let atSignCount = 0;
    let zeroWidthCount = 0;
    let nonAsciiHostCount = 0;
    let doubleSlashCount = 0;
    let redirectToOfficialCount = 0;

    let bankBrandInHost = 0;
    let bankTyposquat = 0;
    let bankClaimNonOfficial = 0;

    let manyUrls = 0;
    let manyHosts = 0;

    const matches: string[] = [];
    const bankMatches: string[] = [];

    const atMatches: string[] = [];
    const zeroWidthMatches: string[] = [];
    const nonAsciiMatches: string[] = [];
    const doubleSlashMatches: string[] = [];
    const redirectToOfficialMatches: string[] = [];

    const bankClaim = looksBankClaimContext(allText);

    const officialRoots = Array.from(new Set((officialSuffixes || []).map((x) => registrableDomain(x)))).filter(Boolean);

    const hostSet = new Set<string>();

    for (const raw of urls) {
        const rawStr = String(raw || "");
        const rawNorm = normalizeToUrlString(rawStr);
        const u = safeParseUrl(rawNorm);
        if (!u) continue;

        const proto = (u.protocol || "").toLowerCase();
        const host = normHost(u.hostname || "");
        const root = registrableDomain(host);
        const path = ((u.pathname || "") + (u.search || "")).toLowerCase();

        if (host) hostSet.add(host);

        const benignAllowed = allow.some((a) => hostMatchesAllow(host, a));

        if (proto === "http:") {
            httpCount += 1;
            matches.push(rawNorm);
        }

        if (SHORTENER_HOSTS.has(host)) {
            shortCount += 1;
            matches.push(host);
        }

        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
            ipHostCount += 1;
            matches.push(host);
        }

        if (isPunycodeHost(host)) {
            punyCount += 1;
            matches.push(host);
        }

        if (countDots(host) >= 4) {
            deepSubCount += 1;
            matches.push(host);
        }

        // '@'로 실제 호스트 숨김(userinfo)
        const hasAtInAuthority = !!(u.username || u.password) || /https?:\/\/[^\s\/]*@/i.test(rawNorm) || /https?:\/\/[^\s\/]*%40/i.test(rawNorm);
        if (hasAtInAuthority) {
            atSignCount += 1;
            atMatches.push(rawNorm);
        }

        // 제로폭/숨김 문자
        if (/[\u200B-\u200F\uFEFF]/.test(rawStr) || /%E2%80%8B|%E2%80%8C|%E2%80%8D|%EF%BB%BF/i.test(rawNorm)) {
            zeroWidthCount += 1;
            zeroWidthMatches.push(rawNorm);
        }

        // 호스트 비ASCII(시각적 유사 문자/혼합 스크립트 등) 힌트
        const hostRaw = String(u.hostname || "");
        if (hostRaw && /[^\x00-\x7F]/.test(hostRaw)) {
            nonAsciiHostCount += 1;
            nonAsciiMatches.push(hostRaw.toLowerCase());
        }

        // 경로 우회(//, %2f%2f 등)
        if (path.includes("//") || path.includes("%2f%2f") || path.includes("%5c%5c")) {
            doubleSlashCount += 1;
            doubleSlashMatches.push(rawNorm);
        }

        if (hasRedirectParam(u)) {
            const chain = extractRedirectParamChain(rawNorm, DEFAULT_MAX_REDIRECT_HOPS);

            redirectParamCount += 1;

            if (chain.length >= 2) {
                const last = chain[chain.length - 1] || "";
                const lu = safeParseUrl(last);
                const lastHost = lu ? normHost(lu.hostname || "") : "";
                matches.push(lastHost ? `${rawNorm} -> ${lastHost} (hops=${chain.length - 1})` : rawNorm);
            } else {
                matches.push(rawNorm);
            }

            // 체인 어디든 “공식 suffix”가 나오면 가점
            const isOfficial = isOfficialBySuffix(host, officialSuffixes);
            if (!isOfficial && !benignAllowed && chain.length >= 2) {
                for (const hopUrl of chain.slice(1)) {
                    const hu = safeParseUrl(hopUrl);
                    if (!hu) continue;
                    const destHost = normHost(hu.hostname || "");
                    if (isOfficialBySuffix(destHost, officialSuffixes)) {
                        redirectToOfficialCount += 1;
                        redirectToOfficialMatches.push(`${host} -> ${destHost}`);
                        break;
                    }
                }
            }
        }

        for (const ext of DOWNLOAD_EXTS) {
            if (path.endsWith(ext) || path.includes(ext + "?") || path.includes(ext + "&")) {
                downloadCount += 1;
                matches.push(rawNorm);
                break;
            }
        }

        const isOfficial = isOfficialBySuffix(host, officialSuffixes);

        const brandHit = hostHasBrandToken(host);
        const brandShort = brandHit ? brandHit.length <= 3 : false;

        // 짧은 토큰은 “은행 사칭 맥락(bankClaim)”일 때만 가점해서 오탐 감소
        if (brandHit && !isOfficial && (!brandShort || bankClaim)) {
            bankBrandInHost += 1;
            bankMatches.push(`${brandHit}@${host}`);
        }

        // 1) allowlist 기반(공식 도메인) root/label 유사도
        if (!isOfficial) {
            const baseLabel = (d: string) => {
                const s = String(d || "").toLowerCase().trim();
                if (!s) return "";
                const first = s.split(".").filter(Boolean)[0] || "";
                return first.replace(/[^a-z0-9-]/g, "");
            };

            const rLabel = baseLabel(root);

            // 1) 공식 도메인 목록(은행 suffix) 기반 typosquat
            if (officialRoots.length) {
                let best = 99;
                let bestOfficial = "";
                let bestMode: "root" | "label" = "root";

                for (const off of officialRoots) {
                    const dRoot = editDistance(root, off);
                    let d = dRoot;
                    let mode: "root" | "label" = "root";

                    const oLabel = baseLabel(off);
                    if (rLabel && oLabel) {
                        const dLabel = editDistance(rLabel, oLabel);
                        if (dLabel < d) {
                            d = dLabel;
                            mode = "label";
                        }
                    }

                    if (d < best) {
                        best = d;
                        bestOfficial = off;
                        bestMode = mode;
                    }
                    if (best === 0) break;
                }

                const bestLabel = bestMode === "label" ? baseLabel(bestOfficial) : "";
                const lenDiff =
                    bestMode === "label"
                        ? Math.abs(rLabel.length - bestLabel.length)
                        : Math.abs(root.length - (bestOfficial || "").length);

                if (bestOfficial && best >= 1 && best <= 2 && lenDiff <= 2) {
                    bankTyposquat += 1;
                    if (bestMode === "label" && rLabel && bestLabel) {
                        bankMatches.push(`${rLabel} ~ ${bestLabel} (d=${best})`);
                    } else {
                        bankMatches.push(`${root} ~ ${bestOfficial} (d=${best})`);
                    }
                }
            }

            // 2) 공식 목록이 비어있거나(또는 누락)해도, 브랜드 토큰 기반으로 fallback typosquat
            if (!officialRoots.length && rLabel) {
                const GENERIC_TAIL4 = new Set(["bank", "card", "pay", "help", "info", "site"]);
                let best = 99;
                let bestBrand = "";

                for (const tk0 of BANK_BRAND_TOKENS) {
                    const tk = String(tk0 || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
                    if (!tk) continue;
                    if (tk.length < 5) continue; // nh/sc/ibk 같은 짧은 토큰 제외(오탐 방지)

                    const tail4 = tk.length >= 6 ? tk.slice(-4) : "";
                    if (tail4 && GENERIC_TAIL4.has(tail4)) continue;

                    // tail4가 있으면 tail4까지는 공유해야 후보로 본다(오탐 감소)
                    if (tail4 && !rLabel.endsWith(tail4)) continue;

                    const d = editDistance(rLabel, tk);
                    const lenDiff = Math.abs(rLabel.length - tk.length);

                    if (d < best) {
                        best = d;
                        bestBrand = tk;
                    }

                    if (best === 0) break;
                }

                if (bestBrand && best >= 1 && best <= 2 && Math.abs(rLabel.length - bestBrand.length) <= 2) {
                    bankTyposquat += 1;
                    bankMatches.push(`${rLabel} ~ ${bestBrand} (d=${best})`);
                }
            }
        }

        // 2) allowlist 누락 대비: 브랜드 토큰(label) 기반 유사도 (예: kdstar.com ~ kbstar)
        if (!isOfficial && !benignAllowed) {
            const lbl = hostBaseLabel(host);
            if (lbl) {
                for (const tk0 of BANK_BRAND_TOKENS) {
                    const tk = normalizeLabel(tk0);
                    if (!tk || tk.length <= 3) continue;

                    const d = editDistance(lbl, tk);
                    const lenDiff = Math.abs(lbl.length - tk.length);

                    // bankClaim이면 조금 넓게(1~2), 아니면 1만 허용해서 오탐 감소
                    const ok = bankClaim ? d >= 1 && d <= 2 && lenDiff <= 2 : d === 1 && lenDiff <= 1;

                    if (ok) {
                        bankTyposquat += 1;
                        bankMatches.push(`${lbl} ~ ${tk} (d=${d})`);
                        break;
                    }
                }
            }
        }

        if (bankClaim && !isOfficial && !benignAllowed) {
            bankClaimNonOfficial += 1;
            bankMatches.push(host);
        }
    }

    const urlCount = Array.isArray(urls) ? urls.length : 0;
    const uniqueHosts = hostSet.size;

    if (urlCount > 0) out.push(points("pf_url_present", "URL 포함", 8, urls));

    if (urlCount >= 3) {
        manyUrls += 1;
        const pts = urlCount >= 8 ? 18 : urlCount >= 5 ? 14 : 10;
        out.push(points("pf_url_many", "링크 다수", pts, [`count=${urlCount}`]));
    }

    if (uniqueHosts >= 3) {
        manyHosts += 1;
        const pts = uniqueHosts >= 6 ? 18 : 12;
        out.push(points("pf_url_many_hosts", "서로 다른 도메인 다수", pts, [`hosts=${uniqueHosts}`]));
    }

    if (shortCount > 0) out.push(points("pf_url_shortener", "단축 URL", 22, matches));
    if (httpCount > 0) out.push(points("pf_url_http", "HTTP(비TLS) URL", 20, matches));
    if (ipHostCount > 0) out.push(points("pf_url_ip_host", "IP 호스트 URL", 24, matches));
    if (punyCount > 0) out.push(points("pf_url_punycode", "훼이크 도메인(푸니코드) 가능", 18, matches));
    if (deepSubCount > 0) out.push(points("pf_url_deep_sub", "과도한 서브도메인", 12, matches));
    if (redirectParamCount > 0) out.push(points("pf_url_redirect_param", "리다이렉트 파라미터 포함", 16, matches));
    if (downloadCount > 0) out.push(points("pf_url_download", "설치/압축 파일 링크", 35, matches));

    if (atSignCount > 0) out.push(points("pf_url_at_sign", "URL에 '@'로 실제 주소 숨김", 22, atMatches));
    if (redirectToOfficialCount > 0) out.push(points("pf_url_redirect_to_official", "리다이렉트가 공식 도메인으로 유도", 24, redirectToOfficialMatches));
    if (zeroWidthCount > 0) out.push(points("pf_url_zero_width", "URL에 숨김 문자(제로폭) 가능", 18, zeroWidthMatches));
    if (nonAsciiHostCount > 0) out.push(points("pf_url_non_ascii", "URL 호스트에 비ASCII 문자 포함", 14, nonAsciiMatches));
    if (doubleSlashCount > 0) out.push(points("pf_url_double_slash", "URL 경로 우회(//, 인코딩) 가능", 10, doubleSlashMatches));

    if (bankBrandInHost > 0) out.push(points("pf_url_bank_brand", "은행명/브랜드 토큰 포함(비공식)", 24, bankMatches));
    if (bankTyposquat > 0) out.push(points("pf_url_bank_typosquat", "은행 도메인 유사(1~2글자 차이)", 30, bankMatches));
    if (bankClaimNonOfficial > 0) out.push(points("pf_url_bank_claim_nonofficial", "은행 사칭 맥락 + 비공식 링크", 18, bankMatches));

    // 링크 많은 케이스인데 다른 신호가 거의 없어도 최소한 "확인 필요"로 끌어올릴 용도(데모)
    if (manyUrls > 0 && manyHosts > 0) {
        out.push(points("pf_url_many_mix", "링크 다수 + 도메인 다수", 10));
    }

    return out;
}

function scoreBareLinkSignals(allText: string, urls: string[]): PrefilterSignal[] {
    const out: PrefilterSignal[] = [];
    if (!Array.isArray(urls) || urls.length === 0) return out;

    const t = String(allText || "").trim();
    if (!t) return out;

    let stripped = t;

    for (const u0 of urls.slice(0, 6)) {
        const u = String(u0 || "");
        if (!u) continue;

        stripped = stripped.split(u).join(" ");

        const uNorm = normalizeToUrlString(u);
        if (uNorm && uNorm !== u) stripped = stripped.split(uNorm).join(" ");
    }

    stripped = stripped.replace(/\s+/g, " ").trim();

    const meaningful = stripped.replace(/[^0-9a-zA-Z가-힣]/g, "");
    const lines = t.split("\n").filter(Boolean).length;

    // 거의 URL만 있는 메시지(스팸/광고/스미싱에서 흔함)
    if (meaningful.length <= 4 && lines <= 2) {
        out.push(points("pf_url_bare_link", "링크만 던짐(스팸/피싱 흔함)", 22, [urls[0]]));
    }

    return out;
}

type ActorHint = "demand" | "comply" | "neutral";

// OTP/인증번호 관련 표현(프리필터/스코어링 간 정합용)
const OTP_CUE_RE =
    /(인증번호|otp|오티피|승인\s*번호|승인번호|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|6\s*자리|6자리)/i;
const OTP_VERB_RE = /(보내|알려|전달|말해|읽어|불러|캡처|스크린샷|입력|말씀)/i;
const OTP_NUM_RE = /(번호|코드|인증|6\s*자리|6자리)/i;

function actorHint(block: string): ActorHint {
    const t = String(block || "").trim();
    if (!t) return "neutral";

    const s = t.toLowerCase();

    // "인증번호/코드 + (보내/알려/말해...)" 류는 단발이라도 demand로 본다
    const otpRelayDemand = OTP_CUE_RE.test(s) && OTP_VERB_RE.test(s) && OTP_NUM_RE.test(s);
    if (otpRelayDemand) return "demand";

    const demand = [
        /입금|송금|이체|결제|납부/,
        /설치|다운|다운로드|원격|팀뷰어|anydesk|quicksupport|화면\s*공유/,
        /(링크|url|주소).*(클릭|눌러|접속|확인)/,
        /지금|즉시|바로|긴급|오늘\s*안에|기한\s*내|통화\s*끊지/,
    ];

    const comply = [
        /^\s*(네|예)\b/,
        /알겠|알겠습니다|확인했|확인했습니다|확인했어요/,
        /보냈|전송했|입력했|설치했|클릭했|눌렀/,
        /인증번호|otp|오티피|비밀번호|계좌번호|카드번호|주민번호|여권/i,
    ];

    let d = 0;
    let c = 0;

    for (const r of demand) if (r.test(s)) d += 1;
    for (const r of comply) if (r.test(s)) c += 1;

    const shortYes = /^\s*(네|예|알겠|알겠습니다)\b/i.test(t) && t.length <= 32;
    if (shortYes && c >= 1) return "comply";
    if (d >= 2 && d > c) return "demand";
    if (c >= 2 && c >= d) return "comply";
    return "neutral";
}

function scoreTextSignals(allText: string): PrefilterSignal[] {
    const t = String(allText || "");
    const s = t.toLowerCase();
    const out: PrefilterSignal[] = [];

    function evidenceFromMatch(m: RegExpExecArray, window = 24) {
        const idx = typeof m.index === "number" ? m.index : -1;
        if (idx < 0) return "";
        const hit = m[0] || "";
        const start = Math.max(0, idx - window);
        const end = Math.min(t.length, idx + hit.length + window);
        const snippet = t.slice(start, end).replace(/\s+/g, " ").trim();
        const prefix = start > 0 ? "…" : "";
        const suffix = end < t.length ? "…" : "";
        return `${prefix}${snippet}${suffix}`;
    }

    function execNoGlobal(re: RegExp, text: string) {
        const flags = re.flags.replace("g", "");
        const safe = new RegExp(re.source, flags);
        return safe.exec(text);
    }

    // ---- 강 신호 ----
    {
        const m = execNoGlobal(/(안전\s*계좌|보호\s*계좌|보호조치\s*계좌|자산\s*이동)/, s);
        if (m) out.push(points("pf_safe_account", "안전/보호계좌 키워드", 32, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(/(송금|이체|입금|결제|납부|보증보험료|수수료\s*입금)/, s);
        if (m) out.push(points("pf_transfer", "송금/결제 유도", 28, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(상품권|문화\s*상품권|문상|해피머니|해피\s*머니|구글\s*기프트|google\s*gift|기프트\s*카드|gift\s*card|핀\s*번호|pin\s*(?:번호|code)|바코드)/,
            s
        );
        if (m) out.push(points("pf_giftcard", "상품권/기프트카드/핀번호 요구", 38, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(usdt|btc|eth|코인|가상\s*자산|가상자산|암호\s*화폐|암호화폐|crypto|wallet|지갑\s*주소|trc20|erc20|바이낸스|binance|업비트|upbit|빗썸|bithumb)/,
            s
        );
        if (m) out.push(points("pf_crypto", "코인/지갑주소 송금 유도", 34, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(통장\s*대여|계좌\s*대여|통장\s*임대|계좌\s*임대|대포\s*통장|명의\s*대여|수령\s*대행|수령대행|자금\s*세탁|범죄\s*자금)/,
            s
        );
        if (m) out.push(points("pf_account_rental", "통장/계좌 대여·수령대행 유도", 36, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(qr\s*코드|qr코드|큐알\s*코드|큐알코드|간편\s*결제|간편결제|토스|카카오\s*페이|kakao\s*pay|네이버\s*페이|naver\s*pay)/,
            s
        );
        if (m) out.push(points("pf_qr_pay", "QR/간편결제 결제 유도", 22, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(/(원격|원격지원|팀뷰어|teamviewer|anydesk|quicksupport|화면\s*공유|접속코드)/, s);
        if (m) out.push(points("pf_remote", "원격/화면공유 유도", 26, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(/(인증번호|otp|오티피|2단계\s*인증|보안코드|확인번호|6\s*자리)/, s);
        if (m) out.push(points("pf_otp", "인증번호/OTP 언급", 18, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(현금\s*(수거|전달|봉투|뭉치)|현금\s*봉투|퀵|퀵서비스|대면\s*(전달|수거)|기사님\s*(수거|방문)|직접\s*(전달|수거)|택시\s*(수거|전달)|봉투를\s*준비)/,
            s
        );
        if (m) out.push(points("pf_cash_pickup", "현금 수거/퀵 전달 유도", 40, evidenceFromMatch(m)));
    }

    // ---- 중 신호 ----
    {
        const m = execNoGlobal(
            /(검찰|검찰청|수사관|경찰|경찰청|사이버\s*수사|금감원|금융감독원|금융보안원|국세청|법원|카드사|은행|고객센터)\s*(입니다|안내|연락|통지)/,
            s
        );
        if (m) out.push(points("pf_authority", "기관/금융사 사칭 톤", 20, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(지급\s*정지|출금\s*정지|거래\s*정지|계좌\s*동결|통장\s*동결|동결\s*조치|압류|가압류|추심|고소|고발|처벌|접속\s*차단|차단\s*예정|계정\s*정지|이용\s*제한|불이익|법적\s*조치|수사\s*대상|영장)/,
            s
        );
        if (m) out.push(points("pf_threat", "위협/불이익 압박", 20, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(계좌|통장|거래|출금|카드).{0,20}(동결|정지|중지|차단|잠금|잠김|제한|압류|가압류|지급\s*정지|출금\s*정지|거래\s*정지|사용\s*정지)/,
            s
        );
        if (m) out.push(points("pf_account_freeze", "계좌/거래 정지·압류 위협", 20, evidenceFromMatch(m)));
    }

    // ✅ account_seizure용: “계좌/거래”뿐 아니라 “계정/로그인/비번” 계열까지 커버 (PF에서 gate 열기)
    {
        const m = execNoGlobal(
            /(이상\s*거래|비정상\s*거래|부정\s*사용|부정\s*결제|명의\s*도용|계좌\s*도용|계정\s*도용|해킹|탈취|침해|로그인\s*(?:시도|차단|제한|이상)|비밀번호\s*(?:변경|초기화|재설정)|계정\s*(?:확인|조회|인증|검증|점검|복구|정지|잠김|잠금|차단|해제)|아이디\s*(?:확인|복구|찾기)?|id\s*(?:확인|복구)?|본인\s*(?:확인|인증)|인증\s*절차|승인\s*내역|결제\s*내역|해외\s*결제)/,
            s
        );
        if (m) out.push(points("pf_account_verify", "계정/계좌 확인·보안점검 유도", 18, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(/(지금|즉시|바로|긴급|오늘\s*안에|기한\s*내|통화\s*끊지\s*마)/, s);
        if (m) out.push(points("pf_urgency", "긴급/시간압박", 10, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(여권|신분증|주민번호|계좌(?:번호)?|카드번호|비밀번호|주소|연락처|이름|인증번호|otp|오티피)\s*(보내|알려|입력|등록|기재|작성|제출|전송|확인)/,
            s
        );
        if (m) out.push(points("pf_pii", "개인정보/신분증 요청", 16, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(링크|url|주소)(?:\s*(?:로|에서|를|에|으로|로써))?(?:.{0,16})?(접속|클릭|눌러|확인|들어가|진행|신청|조회|인증)/,
            s
        );
        if (m) out.push(points("pf_link_verbs", "링크 클릭/접속 유도", 12, evidenceFromMatch(m)));
    }

    // ✅ messenger_phishing용: “카카오” 단독/채팅방/톡방 표현까지 커버해서 pf_link_verbs와 합쳐 gatePass
    {
        const m = execNoGlobal(
            /(카톡|카카오톡|카카오\s*톡|카카오|kakao|톡방|채팅방|오픈\s*채팅|오픈채팅|프로필|내\s*프로필|상태\s*메시지|사진|영상|문서|첨부|메신저|메시지|dm|쪽지)/,
            s
        );
        if (m) out.push(points("pf_messenger_profile", "메신저/프로필 확인 맥락", 8, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(오픈\s*채팅|오픈채팅|open\s*chat|openchat|텔레그램|telegram|카카오\s*오픈|오픈\s*카톡|라인|line|디스코드|discord|1:1|개인\s*톡)/,
            s
        );
        if (m) out.push(points("pf_contact_move", "오픈채팅/텔레그램 등 이동 유도", 18, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(방문|내방|출석|출두|집결|모여|오세요|오셔|오시면|이동해\s*주세요|현장|교육장|면접장|사무실|지점|센터|공항|터미널|역\s*\d*\s*번?\s*출구|출구|주소|오시는\s*길|지도|로비|주차장|층|호)/,
            s
        );
        if (m) out.push(points("pf_visit_place", "특정 장소 방문/이동 유도", 18, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(
            /(고수익|고액|단기|알바|아르바이트|재택|부업|당일\s*지급|초보\s*가능|모집|구인|급구)/,
            s
        );
        if (m) out.push(points("pf_job_hook", "고수익/알바/부업 훅", 10, evidenceFromMatch(m)));
    }

    {
        const m = execNoGlobal(/(인증번호|otp|오티피).*(보내|알려|불러|읽어|전달|캡처|스크린샷|입력)/, s);
        if (m) out.push(points("pf_otp_demand", "인증번호 전달/입력 요구", 22, evidenceFromMatch(m)));
    }

    // ✅ government_subsidy용: “지원금/환급/대상자 조회/정부24” 표현까지 넓게
    {
        const m = execNoGlobal(
            /(지원금|보조금|환급|환불|재난\s*지원금|민생\s*지원금|소상공인\s*지원|근로\s*장려금|자녀\s*장려금|청년\s*지원|대상자\s*(?:조회|확인)|신청\s*(?:가능|대상)|미수령|추가\s*지급|정부\s*24|gov\s*24|gov24)/,
            s
        );
        if (m) out.push(points("pf_benefit_hook", "지원금/환급/대상자 조회 미끼", 12, evidenceFromMatch(m)));

        // 링크/입력 단서가 같이 있으면 더 강하게(점수 누적)
        if (m && /(링크|url|주소|https?:\/\/|www\.|hxxp|\[\.\])/i.test(t)) {
            out.push(points("pf_benefit_link_mention", "지원금/환급 + 링크/URL 언급", 18, evidenceFromMatch(m)));
        }
        if (m && /(계좌|카드|비밀번호|주민번호|신분증|본인\s*인증|로그인|인증번호|otp|오티피|입력|등록)/i.test(t)) {
            out.push(points("pf_benefit_pii", "지원금/환급 + 민감정보/계좌 입력 유도", 20, evidenceFromMatch(m)));
        }
    }

    return out;
}

function scoreCombos(blocks: string[], urls: string[], sigIds: Set<string>, ctx?: PrefilterContext): PrefilterSignal[] {
    const out: PrefilterSignal[] = [];

    const hasUrl = urls.length > 0;
    const hasShort = sigIds.has("pf_url_shortener");
    const hasDl = sigIds.has("pf_url_download");
    const hasOtp = sigIds.has("pf_otp") || sigIds.has("pf_otp_demand");
    const hasRemote = sigIds.has("pf_remote");
    const hasXfer = sigIds.has("pf_transfer");
    const hasSafe = sigIds.has("pf_safe_account");
    const hasUrg = sigIds.has("pf_urgency");
    const hasThreat = sigIds.has("pf_threat");
    const hasUnknown = sigIds.has("pf_unknown_contact");
    const hasMismatch = sigIds.has("pf_url_display_mismatch");

    if (hasUrl && hasOtp) out.push(points("pf_combo_url_otp", "조합: 링크 + 인증번호", 18));
    if (hasRemote && hasOtp) out.push(points("pf_combo_remote_otp", "조합: 원격 + 인증번호", 22));
    if (hasSafe && hasXfer) out.push(points("pf_combo_safe_xfer", "조합: 안전계좌 + 이체", 26));
    if (hasXfer && (hasUrg || hasThreat)) out.push(points("pf_combo_xfer_pressure", "조합: 이체 + 압박", 18));
    if (hasDl && (hasUrg || hasThreat)) out.push(points("pf_combo_install_pressure", "조합: 설치링크 + 압박", 18));
    if (hasShort && hasOtp) out.push(points("pf_combo_short_otp", "조합: 단축URL + OTP", 20));

    // 표시텍스트 불일치는 단독으로도 강하지만, OTP/설치/이체와 붙으면 더 강하게
    if (hasMismatch && (hasOtp || hasDl || hasXfer)) {
        out.push(points("pf_combo_mismatch_strong", "조합: 표시≠실링크 + 강행동", 18));
    }

    // “저장 안 된 번호” + “링크”는 데모에서 강하게 잡아도 됨
    if (hasUnknown && hasUrl) {
        out.push(points("pf_combo_unknown_url", "조합: 미저장 번호 + 링크", 12));
    }

    // ✅ demand→comply(요구→수락/수행) 연쇄는 프리필터에서 다루지 않는다.
    //    (풀필터(scoreThread)에서만 처리)

    // 명시적 행동(복사/설치클릭) + 링크/설치/OTP 조합 (openUrl은 점수에 반영하지 않음)
    const ex = ctx?.explicitActions || {};
    const anyExplicit = (ex.copyUrl ?? 0) + (ex.installClick ?? 0) > 0;
    if (anyExplicit && (hasUrl || hasDl || hasOtp)) {
        out.push(points("pf_combo_explicit_act", "조합: 명시적 행동 + 위험 신호", 14));
    }

    // 클릭(openUrl) + URL 존재: UI 트리거 표식만(가점 없음)
    if ((ex.openUrl ?? 0) > 0 && hasUrl) {
        out.push(points("pf_combo_open_url", "트리거: 클릭 발생 + 링크 존재", 0));
    }

    return out;
}

export function prefilterThread(
    threadText: string,
    opts?: PrefilterOptions
): PrefilterResult & { gatePass: boolean } {
    const recentBlocksMax = Math.max(1, opts?.recentBlocksMax ?? DEFAULT_RECENT_BLOCKS);
    const thresholdSoft = opts?.thresholdSoft ?? DEFAULT_SOFT;
    const thresholdAuto = opts?.thresholdAuto ?? DEFAULT_AUTO;

    const allowHosts = Array.isArray(opts?.allowHosts) ? opts!.allowHosts! : [];

    const bankHosts = Array.isArray(opts?.bankHosts) ? opts!.bankHosts! : KR_BANK_HOST_SUFFIXES;
    const extraFiHosts = Array.isArray(opts?.extraFiHosts) ? opts!.extraFiHosts! : KR_FI_EXTRA_HOST_SUFFIXES;

    const blocks = normalizeBlocks(threadText, recentBlocksMax);
    const windowText = blocks.join("\n");

    // URL 후보(텍스트 기반)
    const urlsLoose = extractUrlsLoose(windowText);

    // 표시텍스트≠실링크 후보(있을 때만)
    const ctx = opts?.context;
    const mdLinks = extractMarkdownLinks(windowText);
    const lcProvided = Array.isArray(ctx?.linkCandidates) ? ctx!.linkCandidates! : [];
    const linkCandidates = [...mdLinks, ...lcProvided].slice(0, 12);

    const signalsUrl = scoreUrlSignals(windowText, urlsLoose, allowHosts, bankHosts, extraFiHosts);
    const signalsText = scoreTextSignals(windowText);
    const signalsCtx = scoreContextSignals(ctx);
    const signalsMismatch = scoreDisplayMismatchSignals(linkCandidates, bankHosts, extraFiHosts);
    const signalsBare = scoreBareLinkSignals(windowText, urlsLoose);

    const allSignals = [...signalsUrl, ...signalsText, ...signalsCtx, ...signalsMismatch, ...signalsBare];

    // id별 최고점만(중복 방지)
    const best = new Map<string, PrefilterSignal>();
    for (const s0 of allSignals) {
        const prev = best.get(s0.id);
        if (!prev || s0.points > prev.points) best.set(s0.id, s0);
    }

    const sigList = Array.from(best.values()).sort((a, b) => b.points - a.points);

    if (opts?.debug) {
        console.log("[PF] signals=", sigList);
    }

    const sigIds = new Set(sigList.map((x) => x.id));

    const combos = scoreCombos(blocks, urlsLoose, sigIds, ctx).sort((a, b) => b.points - a.points);

    const scoreRaw = sigList.reduce((sum, x) => sum + x.points, 0) + combos.reduce((sum, x) => sum + x.points, 0);
    let score = Math.min(100, Math.max(0, Math.round(scoreRaw)));

    let action: PrefilterAction = score >= thresholdAuto ? "auto" : score >= thresholdSoft ? "soft" : "none";

    const openN = Math.max(0, Math.floor(ctx?.explicitActions?.openUrl ?? 0));

    // openUrl은 항상 "트리거 표식"은 남긴다(점수는 URL 신호로만 판단)
    if (openN > 0) {
        best.set("pf_trigger_open_url", points("pf_trigger_open_url", "트리거: URL 열기 시도", 0, [`openUrl=x${openN}`]));
    }

    // ✅ 정책 복구: click/openUrl 발생 + 링크 존재면 "차단 + 검사(auto)" 기본
    if (openN > 0 && urlsLoose.length > 0) {
        score = Math.max(score, thresholdAuto);
        action = "auto";
    }

    const sigListFinal = Array.from(best.values()).sort((a, b) => b.points - a.points);
    const sigIdsFinal = new Set(sigListFinal.map((x) => x.id));

    const trigIds = [...sigListFinal.map((x) => x.id), ...combos.map((x) => x.id)];

    // ✅ gatePass(풀필터 실행 스위치)
    // - 기본: thresholdGate(기본 18) 이상이면 통과
    // - 힌트: 링크 유도/지원금/계좌/계정확인 같은 “시나리오 핵심”은 점수 낮아도 통과
    // - openUrl(+링크)면 무조건 통과
    const thresholdGate = Math.min(18, thresholdSoft);

    const gateHintAccount = sigIdsFinal.has("pf_account_verify") || sigIdsFinal.has("pf_account_freeze");
    const gateHintGov =
        sigIdsFinal.has("pf_benefit_hook") ||
        sigIdsFinal.has("pf_benefit_link_mention") ||
        sigIdsFinal.has("pf_benefit_pii");

    const gateHintMessenger =
        sigIdsFinal.has("pf_link_verbs") && (sigIdsFinal.has("pf_messenger_profile") || sigIdsFinal.has("pf_contact_move"));

    const gateHintLinkVerbs = sigIdsFinal.has("pf_link_verbs");

    // ✅ windowText(최근 N줄)에서 힌트가 잘릴 수 있으니, gatePass만 원문 전체에서 "초저가 힌트"로 보강
    const rawAll = String(threadText ?? "");

    // 줄바꿈/타임스탬프/S:/R: 프리픽스 때문에 (A).{0,N}(B)가 끊기는 케이스가 있어
    // gate 전용으로만 “초저가 정규화”를 한 번 더 적용
    const rawAllLite = rawAll
        .replace(/\r\n/g, "\n")
        .replace(
            /^\s*(\d{4}[-./]\d{2}[-./]\d{2}[ T]\d{2}:\d{2}(?::\d{2})?|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s+(?:오전|오후)?\s*\d{1,2}:\d{2})\s*/gim,
            ""
        )
        .replace(/^\s*(?:S|R)\s*:\s*/gim, "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const gateHintGlobalAccount =
        /(?:계\s*정|계정|아이\s*디|아이디|id|로그\s*인|로그인|비밀\s*번호|비밀번호).{0,48}(?:도\s*용|도용|해\s*킹|해킹|탈\s*취|탈취|잠\s*김|잠김|잠\s*금|잠금|정\s*지|정지|차\s*단|차단|복\s*구|복구|확\s*인|확인|인\s*증|인증|점\s*검|점검)/i.test(
            rawAllLite
        ) ||
        /(?:이상\s*거래|비정상\s*거래|부정\s*사용|부정\s*결제|명의\s*도용|계\s*좌\s*도용|계좌\s*도용|계\s*정\s*도용|계정\s*도용|해외\s*결제|승인\s*내역|결제\s*내역)/i.test(
            rawAllLite
        );

    const gateHintGlobalGov =
        /(?:지원금|보조금|환급|환불|장려금|바우처|쿠폰|재난\s*지원|민생\s*지원|소상공인\s*지원|근로\s*장려금|자녀\s*장려금|청년\s*지원|대상자\s*(?:조회|확인)|정부\s*24|정부24|gov\s*24|gov24)/i.test(
            rawAllLite
        );

    const gateHintGlobalMessenger =
        /(?:카\s*톡|카톡|카카오\s*톡|카카오톡|카카오|kakao|오픈\s*채팅|오픈채팅|텔레그램|telegram|프로필|채팅방|톡방|dm|쪽지).{0,64}(?:링크|url|주소|접속|클릭|확인|초대)/i.test(
            rawAllLite
        );

    const gateHintGlobalLinkVerbs =
        /(?:링크|url|주소)(?:\s*(?:로|에서|를|에|으로|으로써))?.{0,24}(?:클릭|접속|눌러|확인|들어가|진행|신청|조회|인증)/i.test(
            rawAllLite
        );

    const gatePass =
        // ✅ 정책: URL 포함이면 무조건 풀필터로
        urlsLoose.length > 0 ||

        // ✅ 정책: 앵커/신호(점수>0) 하나라도 있으면 통과
        sigListFinal.some((x) => Number((x as any)?.points || 0) > 0) ||
        combos.some((x) => Number((x as any)?.points || 0) > 0) ||

        // 기존 규칙 유지
        score >= thresholdGate ||
        (openN > 0 && urlsLoose.length > 0) ||
        gateHintAccount ||
        gateHintGov ||
        gateHintMessenger ||
        gateHintLinkVerbs ||
        gateHintGlobalAccount ||
        gateHintGlobalGov ||
        gateHintGlobalMessenger ||
        gateHintGlobalLinkVerbs;

    return {
        score,
        action,
        gatePass,
        thresholdSoft,
        thresholdAuto,
        signals: sigListFinal,
        combos,
        trigIds,
        window: {
            blocksConsidered: blocks.length,
            charsConsidered: windowText.length,
        },
    };
}
