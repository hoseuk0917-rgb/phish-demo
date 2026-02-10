// tools/analysis/genScenarioStubsFromClusters.ts (SWAP-IN)
// cluster_pack.json -> JSONL scenario stubs
// + includeContext: pull body_text + attachment_text excerpts from normalized docs
// + cleanup portal/누리집 페이지 footer/nav
// + pick BEST normalized doc among cluster members (not only seed) to avoid ultra-short ctx

import fs from "node:fs";
import path from "node:path";

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

function mustFile(p: string, label: string) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        console.error(`ERROR: ${label} not found: ${p}`);
        process.exit(1);
    }
    return p;
}

function readJson(p: string) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function mkdirp(p: string) {
    fs.mkdirSync(p, { recursive: true });
}

function writeJsonl(p: string, rows: any[]) {
    mkdirp(path.dirname(p));
    const s = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.writeFileSync(p, s, "utf8");
}

function safeStr(x: any) {
    return String(x ?? "").trim();
}

function take<T>(arr: T[], n: number) {
    return arr.slice(0, Math.max(0, n));
}

function uniq<T>(arr: T[]) {
    return [...new Set(arr)];
}

function clampText(s: string, maxChars: number) {
    const t = String(s ?? "");
    if (maxChars <= 0) return t;
    return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function normalizeNewlines(s: string) {
    return String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function toAbsFromRel(relPosix: string) {
    const rel = safeStr(relPosix);
    if (!rel) return "";
    return path.resolve(process.cwd(), rel.replace(/\//g, path.sep));
}

function fileExists(abs: string) {
    try {
        return !!abs && fs.existsSync(abs) && fs.statSync(abs).isFile();
    } catch {
        return false;
    }
}

function readJsonIfExists(abs: string) {
    if (!fileExists(abs)) return null;
    try {
        return JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
        return null;
    }
}

// ✅ portal/누리집 페이지 컨텍스트 정리:
// - 반복/메뉴/헤더/푸터 라인 제거
// - "경찰청 누리집" 이후(하단 링크 리스트) 컷
// - 가능하면 "게시글 보기" 이후를 우선 시작점으로
function cleanPortalishBody(raw: string) {
    const s0 = normalizeNewlines(raw);

    const lines0 = s0.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
    const lines1: string[] = [];

    // 1) 1차 드롭(전형적인 메뉴/헤더 라인)
    const DROP_LINE = [
        /^네이버 연관채널 태그정보$/i,
        /^본문으로 바로가기$/i,
        /^메뉴열기$/i,

        /^로그인$/i,
        /^회원가입$/i,

        /^기관소개$/i,
        /^자주\s*묻는\s*질문$/i,
        /^공지사항$/i,
        /^보도자료$/i,
        /^FAQ$/i,

        /^예방\s*및\s*조치(\s*메뉴)?$/i,
        /^알림[·\.\s]*소식$/i,
    ];

    // 1) drop empties + obvious nav lines + consecutive duplicates
    let prev = "";
    for (const ln of lines0) {
        const t = ln.trim();
        if (!t) continue;

        if (DROP_LINE.some((re) => re.test(t))) continue;

        // 메뉴성 짧은 단독 키워드(“목록” 같은 버튼)
        if (/^목록$/i.test(t)) continue;

        if (t === prev) continue;
        lines1.push(t);
        prev = t;
    }

    // 2) start trim: "게시글 보기" 이후부터가 본문인 경우가 많음
    const idxView = lines1.findIndex((l) => /게시글\s*보기/.test(l));
    let lines2 = idxView >= 0 ? lines1.slice(idxView) : lines1;

    // 3) 이제 "… 게시글 보기" 자체/카테고리 헤더 제거
    lines2 = lines2.filter((l) => !/게시글\s*보기$/.test(l));
    lines2 = lines2.filter((l) => !/^(자주\s*묻는\s*질문|공지사항|보도자료|FAQ)$/i.test(l));

    // 4) cut tail: "경찰청 누리집" footer block
    const idxFooter = lines2.findIndex((l) => /경찰청\s*누리집/.test(l));
    if (idxFooter >= 0) {
        lines2 = lines2.slice(0, idxFooter);
    }

    // 5) optional: "목록"이 나오면 그 아래는 대부분 푸터/네비
    const idxList = lines2.findIndex((l) => /^목록$/.test(l));
    if (idxList >= 0) {
        lines2 = lines2.slice(0, idxList);
    }

    // 6) 마지막 자잘한 고지 제거
    lines2 = lines2.filter((l) => !/^이\s*누리집은\s*대한민국\s*공식\s*전자정부\s*누리집입니다\.?$/.test(l));
    lines2 = lines2.filter((l) => !/이메일\s*주소가\s*자동\s*수집/.test(l));
    lines2 = lines2.filter((l) => !/정보통신망법/.test(l));

    return lines2.join("\n").trim();
}

function cleanAttachmentText(raw: string) {
    const s0 = normalizeNewlines(raw);
    const lines0 = s0.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
    const out: string[] = [];
    let prev = "";
    for (const ln of lines0) {
        const t = ln.trim();
        if (!t) continue;
        if (t === prev) continue;
        // FAQ류에서 반복되는 버튼/링크 문구
        if (/^\[?\s*상세\s*방법\s*확인\s*\]?$/.test(t)) continue;
        if (/^게시글\s*보기$/.test(t)) continue;
        out.push(t);
        prev = t;
    }
    return out.join("\n").trim();
}

function isJunkExampleLine(line: string) {
    const t = String(line ?? "").replace(/\s+/g, " ").trim();
    if (!t) return true;

    // footer/nav 꼬리
    if (/경찰청\s*누리집$/.test(t)) return true;
    if (/누리집$/.test(t) && t.length <= 24) return true;

    // 포털 네비 라인
    if (/^(회원가입|로그인|공지사항|보도자료|목록|기관소개|자주묻는 질문)$/.test(t)) return true;
    if (/게시글\s*보기$/.test(t) && t.length <= 18) return true;

    // footer 지역청 리스트
    if (
        /^(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도남부|경기도북부|강원|충북|충남|전북|전남|경북|경남|제주)\s*경찰청$/.test(
            t
        )
    )
        return true;

    // 법적 고지/수집거부 문구
    if (/본\s*홈페이지에.*이메일\s*주소가\s*자동\s*수집.*거부/.test(t)) return true;

    return false;
}

function normalizeExampleLine(line: string, maxChars = 240) {
    const t = String(line ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    if (t.length <= maxChars) return t;
    return t.slice(0, maxChars) + "…";
}

function flattenExamples(examplesObj: Record<string, string[]>, maxTotal: number) {
    const out: string[] = [];
    const keys = Object.keys(examplesObj || {});
    for (const k of keys) {
        const ex = Array.isArray(examplesObj[k]) ? examplesObj[k] : [];
        for (const line of ex) {
            const t0 = String(line ?? "").trim();
            if (!t0) continue;
            if (isJunkExampleLine(t0)) continue;

            const t = normalizeExampleLine(t0);
            if (!t) continue;
            if (out.includes(t)) continue;

            out.push(t);
            if (out.length >= maxTotal) return out;
        }
    }
    return out;
}

function signalKeyToKoreanHint(key: string) {
    if (key.startsWith("channel:sms")) return "문자";
    if (key.startsWith("channel:call")) return "전화";
    if (key.startsWith("channel:kakao")) return "카톡";
    if (key.startsWith("channel:telegram")) return "텔레그램";
    if (key.startsWith("channel:email")) return "이메일";

    if (key.startsWith("action:phish_link")) return "링크 클릭 유도";
    if (key.startsWith("action:transfer")) return "계좌이체 유도";
    if (key.startsWith("action:cash")) return "현금/ATM 유도";
    if (key.startsWith("action:otp")) return "OTP 요구";
    if (key.startsWith("action:remote")) return "원격제어 유도";
    if (key.startsWith("action:install")) return "앱 설치 유도";
    if (key.startsWith("action:loan")) return "대출 미끼";
    if (key.startsWith("action:job")) return "구직/채용 미끼";

    if (key.startsWith("imp:police") || key.startsWith("impersonation:police")) return "경찰 사칭";
    if (key.startsWith("imp:prosecutor") || key.startsWith("impersonation:prosecutor")) return "검찰 사칭";
    if (key.startsWith("imp:court") || key.startsWith("impersonation:court")) return "법원/영장 사칭";
    if (key.startsWith("imp:bank") || key.startsWith("impersonation:bank")) return "금융기관 사칭";
    if (key.startsWith("imp:courier") || key.startsWith("impersonation:courier")) return "택배/배송 사칭";

    if (key.startsWith("pressure:")) return "협박/압박";

    return key;
}

function buildPromptStub(signature: string, topSignalKeys: string[], examples: string[]) {
    const hints = uniq(topSignalKeys.map(signalKeyToKoreanHint)).filter(Boolean);
    const hintLine = hints.length ? `핵심 패턴: ${hints.join(", ")}` : `signature: ${signature}`;

    const exLines = take(examples, 6);
    const exBlock = exLines.length ? exLines.map((s) => `- ${s}`).join("\n") : "";

    const parts: string[] = [];
    parts.push(`상황: 아래 패턴을 가진 피싱/스캠 대화 시나리오를 구성한다.`);
    parts.push(hintLine);
    if (exBlock) {
        parts.push(`상대가 실제로 할 법한 문장 예시:`);
        parts.push(exBlock);
    }
    parts.push(
        `요구사항: 사용자(피해자)와 사기범(또는 사칭자)의 왕복 6~14턴. 마지막에 행동 유도(링크/이체/OTP/설치/원격 등)를 포함하되, 과도한 폭력/자해 유도는 금지.`
    );
    return parts.join("\n");
}

function tryReadTextFile(relPosix: string, maxChars: number, mode: "attachment" | "body" = "attachment") {
    const abs = toAbsFromRel(relPosix);
    if (!abs) return "";
    try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return "";
        const s = fs.readFileSync(abs, "utf8");
        const cleaned = mode === "attachment" ? cleanAttachmentText(s) : cleanPortalishBody(s);
        return clampText(cleaned, maxChars);
    } catch {
        return "";
    }
}

function inferNormalizedPathFromSignalOut(signalOutPosix: string) {
    // corpus/derived/signals/<source>/pstSn_X.json -> corpus/derived/normalized/<source>/pstSn_X.json
    const out = safeStr(signalOutPosix);
    if (!out) return "";
    return out.replace(/\/signals\//, "/normalized/");
}

function pullContextBlocksFromNormalized(
    normalizedRel: string,
    bodyChars: number,
    attChars: number,
    maxAttFiles: number,
    minTotalChars = 0 // ✅ 0 미만이면 context_blocks 자체를 버림
) {
    const blocks: Array<{ kind: "body" | "attachment"; title?: string; text: string; ref?: string }> = [];

    const abs = toAbsFromRel(normalizedRel);
    if (!abs) return blocks;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return blocks;

    let doc: any;
    try {
        doc = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
        return blocks;
    }

    // 공통 라인 필터(짧은 메뉴/푸터 키워드 제거)
    function stripJunkLines(raw: string) {
        const s = normalizeNewlines(raw);
        const lines = s
            .split("\n")
            .map((l) => l.replace(/\s+/g, " ").trim())
            .filter((l) => !!l);

        const out: string[] = [];
        let prev = "";

        for (const l of lines) {
            const t = l.trim();
            if (!t) continue;

            // 단독 메뉴/버튼/고지
            if (/^(회원가입|로그인|공지사항|보도자료|FAQ|기관소개|목록)$/i.test(t)) continue;
            if (/게시글\s*보기$/.test(t)) continue;

            // 법적 고지/수집거부류
            if (/이메일\s*주소가\s*자동\s*수집/.test(t)) continue;
            if (/정보통신망법/.test(t)) continue;

            // 짧은 “… 누리집” 단독 라인
            if (/누리집$/.test(t) && t.length <= 24) continue;

            if (t === prev) continue;
            out.push(t);
            prev = t;
        }

        return out.join("\n").trim();
    }

    const bodyRaw = safeStr(doc?.body_text);
    if (bodyRaw) {
        const cleanedPortal = cleanPortalishBody(bodyRaw);
        const cleanedLoose = stripJunkLines(cleanedPortal);
        const text = clampText(cleanedLoose, bodyChars);
        if (text.trim()) blocks.push({ kind: "body", title: safeStr(doc?.title) || undefined, text, ref: normalizedRel });
    }

    const atts: any[] = Array.isArray(doc?.attachment_texts) ? doc.attachment_texts : [];
    const withPath = atts
        .map((t) => ({
            name: safeStr(t?.name) || safeStr(t?.saved_as),
            saved_as: safeStr(t?.saved_as),
            text_path: safeStr(t?.text_path),
            chars: Number(t?.chars || 0),
        }))
        .filter((t) => t.text_path);

    // 큰 첨부 우선
    withPath.sort((a, b) => (b.chars || 0) - (a.chars || 0));

    const picked = take(withPath, maxAttFiles);
    for (const p of picked) {
        const raw = tryReadTextFile(p.text_path, attChars);
        if (!raw.trim()) continue;

        const cleaned = stripJunkLines(raw);
        if (!cleaned.trim()) continue;

        blocks.push({
            kind: "attachment",
            title: p.name || undefined,
            text: cleaned,
            ref: p.text_path,
        });
    }

    // ✅ 총 컨텍스트 길이 기준(600 미만이면 버림)
    let total = 0;
    for (const b of blocks) total += String(b.text ?? "").length;

    if (minTotalChars > 0 && total < minTotalChars) return [];

    return blocks;
}

function sumContextChars(blocks: Array<{ text: string }>) {
    let n = 0;
    for (const b of blocks || []) n += String((b as any)?.text ?? "").length;
    return n;
}

function toNormalizedRefFromOut(outOrNorm: string) {
    const s = safeStr(outOrNorm);
    if (!s) return "";
    if (s.includes("/normalized/")) return s;
    return inferNormalizedPathFromSignalOut(s);
}

function pickBestContextFromCandidates(
    candidates: string[],
    bodyChars: number,
    attChars: number,
    maxAttFiles: number,
    minContextChars: number,
    fallbackShortContext: boolean,
    debugLabel?: string
) {
    const uniqCands = uniq(candidates.map((x) => safeStr(x)).filter(Boolean));
    let bestAny: { norm: string; blocks: any[]; chars: number; bodyLen: number; attTop: number } | null = null;
    let bestPass: { norm: string; blocks: any[]; chars: number; bodyLen: number; attTop: number } | null = null;

    for (const cand of uniqCands) {
        const norm = toNormalizedRefFromOut(cand);
        if (!norm) continue;

        const blocks = pullContextBlocksFromNormalized(norm, bodyChars, attChars, maxAttFiles);
        const chars = sumContextChars(blocks);

        // body/att 요약(디버그용)
        let bodyLen = 0;
        let attTop = 0;
        for (const b of blocks) {
            const tlen = String((b as any)?.text ?? "").length;
            if ((b as any)?.kind === "body") bodyLen += tlen;
            if ((b as any)?.kind === "attachment") attTop = Math.max(attTop, tlen);
        }

        const row = { norm, blocks, chars, bodyLen, attTop };

        if (!bestAny || row.chars > bestAny.chars) bestAny = row;
        if (minContextChars > 0 && row.chars >= minContextChars) {
            if (!bestPass || row.chars > bestPass.chars) bestPass = row;
        } else if (minContextChars <= 0 && row.chars > 0) {
            // min이 0이면 “있는 것 중 제일 긴 것”으로 bestPass 취급
            if (!bestPass || row.chars > bestPass.chars) bestPass = row;
        }
    }

    const chosen = bestPass || (fallbackShortContext ? bestAny : null);

    if (debugLabel) {
        const pick = chosen?.norm || "(none)";
        const c = chosen?.chars ?? 0;
        const pass = minContextChars > 0 ? c >= minContextChars : c > 0;
        console.log(
            `[CTX_PICK] ${debugLabel} cand=${uniqCands.length} pick=${pick} ctxChars=${c} min=${minContextChars} pass=${pass} fallback=${fallbackShortContext}`
        );
    }

    if (!chosen) return { normalized_ref: undefined, context_blocks: undefined, ctxChars: 0 };

    if (minContextChars > 0 && chosen.chars < minContextChars && !fallbackShortContext) {
        // ✅ 짧아서 blocks는 버리되, 어떤 normalized가 “최선”이었는지는 남겨둔다(디버그/후처리용)
        return { normalized_ref: chosen.norm, context_blocks: undefined, ctxChars: chosen.chars };
    }

    return {
        normalized_ref: chosen.norm,
        context_blocks: chosen.blocks.length ? chosen.blocks : undefined,
        ctxChars: chosen.chars,
    };
}

function contextChars(blocks: Array<{ text: string }>) {
    let n = 0;
    for (const b of blocks) n += String(b?.text ?? "").length;
    return n;
}

function scoreNormalizedForContext(normalizedRel: string, bodyChars: number, attChars: number, maxAttFiles: number) {
    const abs = toAbsFromRel(normalizedRel);
    const doc = readJsonIfExists(abs);
    if (!doc) return null;

    const bodyRaw = safeStr(doc?.body_text);
    const bodyClean = bodyRaw ? cleanPortalishBody(bodyRaw) : "";
    const bodyLen = bodyClean.trim().length;

    const atts: any[] = Array.isArray(doc?.attachment_texts) ? doc.attachment_texts : [];
    const withMeta = atts
        .map((t) => ({
            chars: Number(t?.chars || 0),
        }))
        .filter((t) => Number.isFinite(t.chars) && t.chars > 0)
        .sort((a, b) => (b.chars || 0) - (a.chars || 0));

    const attTop = take(withMeta, maxAttFiles).reduce((acc, x) => acc + (x.chars || 0), 0);

    // ✅ score: body + (top attachments) + small heuristics to avoid ultra-short portal scraps
    let score = 0;
    score += Math.min(bodyLen, bodyChars > 0 ? bodyChars : bodyLen);
    score += Math.min(attTop, attChars * maxAttFiles);

    if (bodyLen < 120) score -= 80;
    if (bodyLen < 220 && attTop > 0) score += 150;
    if (attTop === 0 && bodyLen < 400) score -= 120;

    return {
        normalizedRel,
        score,
        bodyLen,
        attTop,
        title: safeStr(doc?.title) || undefined,
    };
}

function pickBestNormalizedRefForCluster(
    c: any,
    refs: any[],
    bodyChars: number,
    attChars: number,
    maxAttFiles: number
) {
    const candOuts: string[] = [];

    const seedOut = safeStr(c?.seed_out) || safeStr(c?.seed_doc) || safeStr(c?.seed);
    if (seedOut) candOuts.push(seedOut);

    for (const r of refs || []) {
        const o = safeStr((r as any)?.out);
        if (o) candOuts.push(o);
    }

    const candNorms = uniq(candOuts.map(inferNormalizedPathFromSignalOut).filter(Boolean));

    const scored = candNorms
        .map((nr) => scoreNormalizedForContext(nr, bodyChars, attChars, maxAttFiles))
        .filter(Boolean) as Array<{
            normalizedRel: string;
            score: number;
            bodyLen: number;
            attTop: number;
            title?: string;
        }>;

    scored.sort((a, b) => b.score - a.score);

    return scored.length ? scored[0] : null;
}

async function main() {
    const args = parseArgs(process.argv);

    const packPath = path.resolve(String(args.clusters || args.pack || "./corpus/derived/analysis/cluster_pack.json"));
    const outPath = path.resolve(String(args.out || "./datasets/ko_scam/scenario_stubs_from_clusters.jsonl"));

    const perClusterMembers = Number(args.perClusterMembers || 6);
    const maxExampleLines = Number(args.maxExampleLines || 10);

    const includeContext = asBool(args.includeContext, false);
    const bodyChars = Number(args.bodyChars || args.contextChars || 1600);
    const attChars = Number(args.attChars || 1400);
    const maxAttFiles = Number(args.maxAttFiles || 2);
    const minContextChars = Number(args.minContextChars || 0);
    const fallbackShortContext = asBool(args.fallbackShortContext, false);

    const debug = asBool(args.debug, false);

    mustFile(packPath, "cluster_pack");

    const pack = readJson(packPath);
    const sigs = Array.isArray(pack?.signatures) ? pack.signatures : [];

    const rows: any[] = [];

    for (const s of sigs) {
        const signature = safeStr(s?.signature);
        const clusters = Array.isArray(s?.clusters) ? s.clusters : [];
        for (const c of clusters) {
            const cid = safeStr(c?.id);
            const clusterId = `${signature}::${cid}`;

            const topSignals = Array.isArray(c?.top_signals) ? c.top_signals : [];
            const topSignalKeys = topSignals.map((x: any) => safeStr(x?.key)).filter(Boolean);

            const examplesObj = (c?.examples || {}) as Record<string, string[]>;
            const examples = take(flattenExamples(examplesObj, maxExampleLines), maxExampleLines);

            const members = Array.isArray(c?.members) ? c.members : [];
            const refs = take(
                members
                    .slice()
                    .sort((a: any, b: any) => Number(b?.score_top || 0) - Number(a?.score_top || 0))
                    .map((m: any) => ({
                        source: safeStr(m?.source),
                        pstSn: safeStr(m?.pstSn),
                        date: safeStr(m?.date) || undefined,
                        title: safeStr(m?.title) || undefined,
                        out: safeStr(m?.out),
                    }))
                    .filter((x: any) => x.source && x.pstSn && x.out),
                perClusterMembers
            );

            const prompt_stub = buildPromptStub(signature, topSignalKeys, examples);

            let context_blocks: any[] | undefined = undefined;
            let normalized_ref: string | undefined = undefined;

            if (includeContext) {
                const seedOut = safeStr(c?.seed_out) || safeStr(c?.seed_doc) || safeStr(c?.seed);

                // 후보: seed + refs(out) 전부
                const cand: string[] = [];
                if (seedOut) cand.push(seedOut);
                for (const r of refs) {
                    if ((r as any)?.out) cand.push(String((r as any).out));
                }

                const picked = pickBestContextFromCandidates(
                    cand,
                    bodyChars,
                    attChars,
                    maxAttFiles,
                    minContextChars,
                    fallbackShortContext,
                    `${clusterId}`
                );

                normalized_ref = picked.normalized_ref;
                context_blocks = picked.context_blocks;

                if (debug) {
                    console.log(`[CTX] ${clusterId} ctxChars=${picked.ctxChars} min=${minContextChars} ctx=${context_blocks ? context_blocks.length : 0}`);
                }
            }

            rows.push({
                id: `stub_${rows.length + 1}`,
                cluster_id: clusterId,
                signature,
                cluster: cid,
                seed_doc: safeStr(c?.seed_out) || safeStr(c?.seed_doc) || safeStr(c?.seed),
                signals_top: take(topSignalKeys, 12),
                prompt_stub,
                normalized_ref,
                context_blocks,
                source_refs: refs,
            });

            if (debug) {
                const cc = context_blocks ? contextChars(context_blocks) : 0;
                console.log(
                    `[STUB] ${clusterId} refs=${refs.length} signals=${topSignalKeys.length} ex=${examples.length} ctx=${context_blocks ? context_blocks.length : 0} ctxChars=${cc}`
                );
            }
        }
    }

    writeJsonl(outPath, rows);

    console.log(`stubs_written: ${rows.length}`);
    console.log(`out: ${outPath}`);
}

main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
});
