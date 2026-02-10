import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { pipeline, env } from "@xenova/transformers";
import { freezeText } from "./mutate/freeze.js";
import { jaccard3gramDistance } from "./mutate/lexical.js";
import { createEmbedder, cosineSimNormalized } from "./mutate/embed.js";

import { analyzeThread } from "../src/engine/index";

type AnyRow = Record<string, any>;

type MutatedMetaV1 = {
    schema_version: "mutated.v1";
    track: "mutated";
    parent: { parent_id: string; parent_sha256_utf8?: string };
    freeze: {
        policy_version: "freeze.v1";
        enabled: boolean;
        spans: any[];
        verify: { restored_ok: boolean; mismatch_placeholders?: string[] };
    };
    mutation: {
        generator: "mlm" | "rules" | "mixed";
        model?: { name: string; revision?: string };
        seed: number;
        variant_no: number;
        mode: "anchor_preserve" | "anchor_shake";
        steps: Array<any>;
        text_scope: { basis: "S_only" | "S_and_R"; protected_placeholders: true };
    };
    gates: {
        decision: "keep" | "drop";
        drop_reason?: string;
        embedding: { model: string; sim: number; min_sim_keep: number };
        lexical: { metric: "jaccard_3gram"; distance: number; min_dist_keep: number; max_dist_keep?: number };
        anchors: { preserve_expected: boolean; diff?: { added: string[]; removed: string[] } };
        engine?: {
            enabled: boolean;
            got?: { risk?: string; stage?: string; score?: number; triggered?: boolean };
            exp?: { risk?: string; stage?: string; score_min?: number; triggered?: boolean };
        };
    };
    reproducibility: {
        created_at: string;
        tool: { name: string; version: string };
        code?: { git_commit?: string };
        config_digest?: string;
        preset?: string;
    };
};

type MaskScope = "any" | "style";

type Preset = {
    preset: string;
    title: string;
    targetKept: number;
    nPerParent: number;
    rounds: number;
    topK: number;
    minSimKeep: number;
    minDistKeep: number;
    maxDistKeep?: number;
    mode: "anchor_preserve" | "anchor_shake";
    maskScope: MaskScope;
    freezeKeywords: string[];
    anchorTerms: string[];
};

function sha256utf8(s: string) {
    return crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

function arg(key: string) {
    const idx = process.argv.indexOf(key);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}
function hasFlag(key: string) {
    return process.argv.includes(key);
}
function argNum(key: string, def: number) {
    const v = arg(key);
    if (!v) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}
function argStr(key: string, def: string) {
    const v = arg(key);
    return v ?? def;
}
function argList(key: string) {
    const v = arg(key);
    if (!v) return [];
    return v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
}

function splitSR(thread: string) {
    const lines = String(thread ?? "").split(/\r?\n/);
    const sIdx: number[] = [];
    const rIdx: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trimStart();
        if (t.startsWith("S:")) sIdx.push(i);
        else if (t.startsWith("R:")) rIdx.push(i);
    }
    const sText = sIdx.map((i) => lines[i].replace(/^\s*S:\s?/, "")).join("\n");
    const rText = rIdx.map((i) => lines[i].replace(/^\s*R:\s?/, "")).join("\n");
    return { lines, sIdx, rIdx, sText, rText };
}

// 아주 단순한 seeded RNG (LCG)
function makeRng(seed: number) {
    let x = seed >>> 0;
    return () => {
        x = (1664525 * x + 1013904223) >>> 0;
        return x / 0xffffffff;
    };
}

function pickOne<T>(arr: T[], rng: () => number) {
    return arr[Math.floor(rng() * arr.length)];
}

// ✅ 토큰 정규화: 비교용(대소문자/구두점/공백 제거)
function normTok(s: string) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ""); // letters+numbers만 남김
}

// ✅ placeholder spacing 정규화
function normalizeAnglePlaceholderSpacing(s: string) {
    return String(s ?? "").replace(
        /<\s*([A-Za-z_]+)\s*_\s*(\d+)\s*>/g,
        (_m, a, n) => `<${String(a).toUpperCase()}_${n}>`
    );
}

// ✅ placeholder 바로 뒤 구두점 분리(restore_mismatch 감소 핵심)
function detachPunctFromPlaceholders(s: string) {
    return String(s ?? "").replace(/(<[A-Z_]+_\d+>)([.,!?])/g, "$1 $2");
}

// ✅ parentS에 “없던” 앵커 토큰은 MLM이 새로 주입하지 못하게 deny 목록 생성(Set)
function buildDenyTokenSet(parentS: string, anchorTerms: string[]) {
    const s = String(parentS || "").toLowerCase();
    const deny: string[] = [];
    for (const t0 of anchorTerms || []) {
        const t = String(t0 || "").trim();
        if (!t) continue;

        // 다단어/슬래시/쉼표 포함은 token_str와 매칭이 애매해서 제외
        if (/[\/\s,]/.test(t)) continue;

        if (!s.includes(t.toLowerCase())) deny.push(t);
    }
    return new Set(Array.from(new Set(deny.map((x) => normTok(x)).filter(Boolean))));
}

// ✅ style-only 마스킹용 토큰(의미 단어를 안 건드리고 말투/연결어 중심)
const STYLE_TOKENS_KO = new Set(
    [
        "입니다",
        "이에요",
        "예요",
        "요",
        "죠",
        "네요",
        "거든요",
        "합니다",
        "드립니다",
        "드릴게요",
        "해주세요",
        "부탁드립니다",
        "확인",
        "확인용",
        "잠시",
        "조금",
        "좀",
        "먼저",
        "우선",
        "다만",
        "만",
        "정도",
        "관련",
        "문의",
        "안내",
        "연락",
        "가능",
        "필요",
        "진행",
        "처리",
    ].map((x) => normTok(x))
);

function maskOneToken(text: string, rng: () => number, scope: MaskScope) {
    // whitespace 토큰 유지하려고 split
    const parts = String(text ?? "").split(/(\s+)/);

    type Cand = { i: number; repl: string };
    const candidates: Cand[] = [];

    for (let i = 0; i < parts.length; i++) {
        const p0 = parts[i];
        if (!p0 || /^\s+$/.test(p0)) continue;

        // placeholder/보호토큰은 절대 마스킹 금지
        if (/^<([A-Z_]+)_\d+>$/.test(p0)) continue;
        if (/^__PLH_\d+__$/.test(p0)) continue;

        // 깨진 placeholder 조각 방지
        if (p0.includes("<") || p0.includes(">")) continue;

        // [MASK] 조각 방지
        if (p0.includes("[") || p0.includes("]")) continue;

        // 숫자 포함은 제외
        if (/\d/.test(p0)) continue;

        // 너무 짧은 토큰 제외
        if (p0.length < 2) continue;

        const nt = normTok(p0);
        if (!nt) continue;

        if (scope === "style") {
            // 토큰 끝 구두점 분리
            const punct = /[.,!?]$/.test(p0) ? p0.slice(-1) : "";
            const p = punct ? p0.slice(0, -1) : p0;

            // “접미 공손표현”만 마스킹: 줄기(stem) 보존 → 의미 고정 + 변화폭 확보
            const m = p.match(
                /^(.*?)(해주세요|주십시오|부탁드립니다|바랍니다|드립니다|드릴게요|할게요|해요|입니다|합니다|됩니다|되세요|가능하신가요|가능하실까요|가능합니까)$/
            );
            if (m && m[1] && m[1].length >= 1) {
                const stem = m[1];
                candidates.push({ i, repl: `${stem} [MASK]${punct}` });
                continue;
            }

            // fallback: 기존 로직(어미처럼 보이는 토큰만)
            const looksLikeEnding =
                /요$/.test(p0) ||
                /니다$/.test(p0) ||
                /습니다$/.test(p0) ||
                /세요$/.test(p0) ||
                /드립니다$/.test(p0) ||
                /합니다$/.test(p0);

            if (!STYLE_TOKENS_KO.has(nt) && !looksLikeEnding) continue;
            candidates.push({ i, repl: "[MASK]" });
            continue;
        }

        // any 모드
        candidates.push({ i, repl: "[MASK]" });
    }

    if (candidates.length === 0) return { masked: text, didMask: false };

    const c = pickOne(candidates, rng);
    parts[c.i] = c.repl;
    return { masked: parts.join(""), didMask: true };
}

function extractAnglePlaceholders(s: string) {
    const out = new Set<string>();
    const re = /<([A-Z_]+)_\d+>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(s))) !== null) out.add(m[0]);
    return [...out];
}

// style 모드에서 freeze를 끄더라도, 기존 <..._n> 플레이스홀더는 절대 깨지지 않게 보호
function protectAnglePlaceholders(s: string) {
    const map = new Map<string, string>();
    let text = String(s ?? "");
    const phs = extractAnglePlaceholders(text);
    phs.forEach((ph, i) => {
        const key = `__PLH_${i}__`;
        map.set(key, ph);
        text = text.split(ph).join(key);
    });
    return { text, map };
}

function unprotectAnglePlaceholders(s: string, map: Map<string, string>) {
    let text = String(s ?? "");
    for (const [key, ph] of map.entries()) {
        text = text.split(key).join(ph);
    }
    return text;
}

async function fillOneMask(unmasker: any, masked: string, topK: number, rng: () => number, denySet?: Set<string>) {
    const out: any = await unmasker(masked, { top_k: topK });
    const candList = Array.isArray(out) ? out : [];
    const usable = candList.filter((x) => typeof x?.sequence === "string" && typeof x?.token_str === "string");
    if (!usable.length) return { text: masked, filled: false };

    const mustKeep = extractAnglePlaceholders(masked);

    const filtered = usable.filter((x) => {
        const seq = String(x.sequence);
        if (seq.includes("[MASK]")) return false;

        for (const t of mustKeep) if (!seq.includes(t)) return false;

        // denySet: token_str 기준으로 차단
        if (denySet && denySet.size) {
            const tok = normTok(String(x.token_str));
            if (tok && denySet.has(tok)) return false;
        }
        return true;
    });

    const pool = filtered.length
        ? filtered
        : usable.filter((x) => {
            const seq = String(x.sequence);
            if (seq.includes("[MASK]")) return false;
            for (const t of mustKeep) if (!seq.includes(t)) return false;
            return true;
        });

    if (!pool.length) return { text: masked, filled: false };

    const chosen = pickOne(pool, rng);
    const seq = detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(String(chosen.sequence)));
    return { text: seq, filled: true };
}

function rebuildThread(lines: string[], sIdx: number[], newS: string) {
    const out = [...lines];
    if (!sIdx.length) return out.join("\n");

    const origS = sIdx.map((i) => String(out[i] ?? "").replace(/^\s*S:\s?/, "").trimEnd());

    const raw = String(newS ?? "");
    const rawLines = raw.split(/\r?\n/).map((x) => x.trimEnd());
    const merged = rawLines.join(" ").replace(/\s+/g, " ").trim();

    if (sIdx.length === 1) {
        const text = merged || origS[0] || "";
        out[sIdx[0]] = `S: ${text}`.trimEnd();
        return out.join("\n");
    }

    if (rawLines.length < sIdx.length) {
        out[sIdx[0]] = `S: ${merged || origS[0] || ""}`.trimEnd();
        for (let i = 1; i < sIdx.length; i++) {
            out[sIdx[i]] = `S: ${origS[i] || ""}`.trimEnd();
        }
        return out.join("\n");
    }

    for (let i = 0; i < sIdx.length; i++) {
        const isLast = i === sIdx.length - 1;
        const chunk = isLast ? rawLines.slice(i).join(" ").replace(/\s+/g, " ").trim() : (rawLines[i] ?? "").trim();
        const text = chunk || origS[i] || "";
        out[sIdx[i]] = `S: ${text}`.trimEnd();
    }

    for (let i = 0; i < sIdx.length; i++) {
        const line = String(out[sIdx[i]] ?? "");
        if (/^\s*S:\s*$/.test(line)) out[sIdx[i]] = `S: ${origS[i] || ""}`.trimEnd();
    }

    return out.join("\n");
}

async function readJsonl(p: string) {
    const raw = await fs.readFile(p, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l) as AnyRow);
}

async function ensureDir(p: string) {
    await fs.mkdir(p, { recursive: true });
}

function nowIsoKST() {
    return new Date().toISOString();
}

// ---- engine-gate debug / compat ----
let _ENGINEGATE_DUMPED = false;

function _safeStringify(obj: any) {
    const seen = new WeakSet<object>();
    return JSON.stringify(
        obj,
        (_k, v) => {
            if (v && typeof v === "object") {
                if (seen.has(v)) return "[Circular]";
                seen.add(v);
            }
            if (typeof v === "bigint") return v.toString();
            return v;
        },
        2
    );
}

function _describeShape(o: any, maxProto = 6) {
    const lines: string[] = [];
    try {
        if (o === null) return "null";
        if (o === undefined) return "undefined";
        if (typeof o !== "object") return `typeof=${typeof o} value=${String(o)}`;

        lines.push(`ctor=${o?.constructor?.name ?? "(unknown)"}`);
        lines.push(`ownNames=${Object.getOwnPropertyNames(o).join(",")}`);
        const syms = Object.getOwnPropertySymbols(o).map((s) => String(s));
        if (syms.length) lines.push(`ownSymbols=${syms.join(",")}`);

        let cur = o;
        for (let i = 0; i < maxProto; i++) {
            cur = Object.getPrototypeOf(cur);
            if (!cur) break;
            lines.push(`proto[${i}] ctor=${cur?.constructor?.name ?? "(unknown)"}`);
            lines.push(`proto[${i}] ownNames=${Object.getOwnPropertyNames(cur).join(",")}`);
        }
    } catch (e: any) {
        lines.push(`shape_error=${String(e?.message ?? e)}`);
    }
    return lines.join("\n");
}

async function _dumpEngineGateOnce(tag: string, got0: any) {
    if (_ENGINEGATE_DUMPED) return;
    _ENGINEGATE_DUMPED = true;

    try {
        const base = "datasets/ko_scam/mutated";
        await ensureDir(base);

        const p1 = path.join(base, `engine_gate_dump_${tag}.json`);
        const p2 = path.join(base, `engine_gate_dump_${tag}_shape.txt`);

        await fs.writeFile(p1, _safeStringify(got0) + "\n", "utf8");
        await fs.writeFile(p2, _describeShape(got0) + "\n", "utf8");
    } catch {
        // ignore dump failures
    }
}

// ---- analyzeThreadCompat: payload 캐시로 대폭 가속 ----
let _ENGINE_PAYLOAD_PREF: { name: string; make: (text: string, msgs: any[], blocks: any[]) => any } | null = {
    name: "threadText",
    make: (text: string) => ({ threadText: text }),
};

async function analyzeThreadCompat(mutatedThread: string) {
    const text = String(mutatedThread ?? "");

    const lines = text.split(/\r?\n/);
    const msgs = lines
        .map((l) => String(l ?? "").trimStart())
        .filter((l) => l.startsWith("S:") || l.startsWith("R:"))
        .map((l) => {
            const isS = l.startsWith("S:");
            const body = l.replace(/^[SR]:\s?/, "").trim();
            return {
                role: isS ? "S" : "R",
                who: isS ? "S" : "R",
                speaker: isS ? "S" : "R",
                text: body,
                content: body,
            };
        });

    const blocks = msgs.map((m, i) => ({
        id: String(i),
        role: m.role,
        speaker: m.speaker,
        text: m.text,
        content: m.content,
    }));

    const payloads: Array<{ name: string; make: (text: string, msgs: any[], blocks: any[]) => any }> = [
        // ✅ 정답 payload (네가 확인함)
        { name: "threadText", make: (t) => ({ threadText: t }) },

        // 최소 fallback (엔진 바뀌었을 때만 사용)
        { name: "rawThreadText", make: (t) => ({ rawThreadText: t }) },
        { name: "messages(role/text)", make: (_t, m) => ({ messages: m }) },
        { name: "blocks", make: (_t, _m, b) => ({ blocks: b }) },
    ];

    // pref가 있으면 맨 앞으로
    const ordered = _ENGINE_PAYLOAD_PREF
        ? [_ENGINE_PAYLOAD_PREF, ...payloads.filter((p) => p.name !== _ENGINE_PAYLOAD_PREF!.name)]
        : payloads;

    let last: any = null;
    let lastName = "none";
    let lastErr: any = null;

    for (const p of ordered) {
        try {
            const got0: any = await analyzeThread(p.make(text, msgs, blocks));
            last = got0;
            lastName = p.name;

            const mc = Number(got0?.messageCount ?? 0);
            const chars = Number(got0?.prefilter?.window?.charsConsidered ?? 0);
            const hitsLen = Array.isArray(got0?.hitsTop) ? got0.hitsTop.length : 0;

            const good = mc > 0 || chars > 0 || hitsLen > 0;
            if (good) {
                _ENGINE_PAYLOAD_PREF = p; // ✅ 이후부터는 이거만 씀
                return { got0, payloadName: p.name };
            }
        } catch (e) {
            lastErr = e;
        }
    }

    if (!last) {
        return { got0: { __engine_gate_error: String(lastErr?.message ?? lastErr) }, payloadName: "error" };
    }
    return { got0: last, payloadName: lastName };
}

function normKey(k: string) {
    return String(k || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function pickStr(v: any): string {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (v && typeof v === "object") {
        if (typeof (v as any).id === "string") return (v as any).id;
        if (typeof (v as any).level === "string") return (v as any).level;
        if (typeof (v as any).name === "string") return (v as any).name;
        if (typeof (v as any).value === "string") return (v as any).value;
    }
    return "";
}

function pickFiniteNumber(v: any): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function collectDeep(root: any, maxDepth = 10, maxNodes = 1200) {
    const out: any[] = [];
    const q: Array<{ v: any; d: number }> = [{ v: root, d: 0 }];
    const seen = new WeakSet<object>();

    while (q.length) {
        const { v, d } = q.shift()!;
        if (!v) continue;

        const t = typeof v;
        if (t !== "object") continue;

        if (seen.has(v as object)) continue;
        seen.add(v as object);

        out.push(v);
        if (out.length >= maxNodes) break;
        if (d >= maxDepth) continue;

        const push = (x: any) => {
            if (x && typeof x === "object") q.push({ v: x, d: d + 1 });
        };

        push((v as any).result);
        push((v as any).analysis);
        push((v as any).scored);
        push((v as any).meta);
        push((v as any).data);
        push((v as any).output);
        push((v as any).payload);
        push((v as any).value);

        if (Array.isArray(v)) {
            for (const it of v) push(it);
            continue;
        }

        for (const key of Object.keys(v as any)) {
            push((v as any)[key]);
        }
    }

    return out;
}

function deepPickString(root: any, keys: string[]) {
    const want = new Set(keys.map(normKey));
    const nodes = collectDeep(root);

    for (const node of nodes) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;

        for (const [k, val] of Object.entries(node)) {
            if (!want.has(normKey(k))) continue;
            const s = pickStr(val);
            if (s) return s;
        }
    }
    return "";
}

function deepPickNumber(root: any, keys: string[]) {
    const want = new Set(keys.map(normKey));
    const nodes = collectDeep(root);

    for (const node of nodes) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;

        for (const [k, val] of Object.entries(node)) {
            if (!want.has(normKey(k))) continue;
            const n = pickFiniteNumber(val);
            if (typeof n === "number") return n;
        }
    }
    return undefined;
}

function deepPickBool(root: any, keys: string[]) {
    const want = new Set(keys.map(normKey));
    const nodes = collectDeep(root);

    for (const node of nodes) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;

        for (const [k, val] of Object.entries(node)) {
            if (!want.has(normKey(k))) continue;
            if (typeof val === "boolean") return val;
        }
    }
    return undefined;
}

// ---- engine-gate robust pickers ----
function _eg_pickStr(v: any): string {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (v && typeof v === "object") {
        if (typeof (v as any).id === "string") return (v as any).id;
        if (typeof (v as any).level === "string") return (v as any).level;
        if (typeof (v as any).name === "string") return (v as any).name;
        if (typeof (v as any).value === "string") return (v as any).value;
    }
    return "";
}

function _eg_pickNum(v: any): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function _eg_collectDeep(root: any, maxDepth = 10, maxNodes = 1600) {
    const out: any[] = [];
    const q: Array<{ v: any; d: number }> = [{ v: root, d: 0 }];
    const seen = new WeakSet<object>();

    while (q.length) {
        const { v, d } = q.shift()!;
        if (!v) continue;

        if (typeof v !== "object") continue;
        if (seen.has(v as object)) continue;
        seen.add(v as object);

        out.push(v);
        if (out.length >= maxNodes) break;
        if (d >= maxDepth) continue;

        const push = (x: any) => {
            if (x && typeof x === "object") q.push({ v: x, d: d + 1 });
        };

        push((v as any).result);
        push((v as any).analysis);
        push((v as any).scored);
        push((v as any).meta);
        push((v as any).data);
        push((v as any).output);
        push((v as any).payload);
        push((v as any).value);

        if (Array.isArray(v)) {
            for (const it of v) push(it);
            continue;
        }

        for (const k of Object.keys(v as any)) push((v as any)[k]);
    }

    return out;
}

function _eg_getAny(node: any, keys: string[]) {
    if (!node || typeof node !== "object") return undefined;
    for (const k of keys) {
        try {
            if (k in node) return (node as any)[k];
        } catch {
            // ignore getter throw
        }
    }
    return undefined;
}

function _eg_deepPickBool(root: any, keys: string[]) {
    const nodes = _eg_collectDeep(root);
    for (const node of nodes) {
        const v = _eg_getAny(node, keys);
        if (typeof v === "boolean") return v;
    }
    return undefined;
}

const _EG_STAGE_RANK: Record<string, number> = {
    none: 0,
    info: 1,
    verify: 2,
    payment: 3,
    install: 4,
};

function _eg_normStage(x: any): string {
    return String(x ?? "").trim().toLowerCase();
}

function _eg_peakStageFromTimeline(tl: any): string {
    const arr = Array.isArray(tl)
        ? tl
        : Array.isArray(tl?.items)
            ? tl.items
            : Array.isArray(tl?.timeline)
                ? tl.timeline
                : Array.isArray(tl?.stageTimeline)
                    ? tl.stageTimeline
                    : undefined;

    if (!Array.isArray(arr) || !arr.length) return "";

    let bestStage = "";
    let bestRank = -1;

    for (const it of arr) {
        if (!it) continue;
        const s =
            _eg_normStage((it as any).stage) ||
            _eg_normStage((it as any).stageId) ||
            _eg_normStage((it as any).peakStage) ||
            _eg_normStage((it as any).stagePeak);

        if (!s) continue;

        const r = _EG_STAGE_RANK[s] ?? -1;
        if (r > bestRank) {
            bestRank = r;
            bestStage = s;
        }
    }
    return bestStage;
}

function pickRiskId(got0: any): string {
    const nodes = _eg_collectDeep(got0);
    // 1) 안정 키들
    for (const node of nodes) {
        const v = _eg_getAny(node, ["riskLevel", "riskLevelId", "risk_level", "risk_level_id"]);
        const s = _eg_pickStr(v);
        if (s) return s;
    }
    // 2) fallback
    for (const node of nodes) {
        const v = _eg_getAny(node, ["risk", "riskId"]);
        const s = _eg_pickStr(v);
        if (s) return s;
    }
    return "";
}

function pickStageId(got0: any): string {
    // 1) timeline peak 우선
    const nodes = _eg_collectDeep(got0);
    for (const node of nodes) {
        const tlAny = _eg_getAny(node, ["stageTimeline", "stage_timeline"]);
        if (tlAny === undefined) continue;

        const peak = _eg_peakStageFromTimeline(tlAny);
        if (peak) return peak;
    }
    // 2) fallback peak 계열
    for (const node of nodes) {
        const v = _eg_getAny(node, ["stagePeak", "stagePeakId", "stage_peak", "stage_peak_id", "peakStage", "peak_stage"]);
        const s = _eg_pickStr(v);
        if (s) return s;
    }
    return "";
}

function pickScoreTotal(got0: any): number {
    const nodes = _eg_collectDeep(got0);

    // 1) total 계열
    for (const node of nodes) {
        const v = _eg_getAny(node, ["scoreTotal", "score_total", "totalScore", "total_score"]);
        const n = _eg_pickNum(v);
        if (typeof n === "number") return n;
    }

    // 2) timeline max score
    for (const node of nodes) {
        const tl = _eg_getAny(node, ["stageTimeline", "stage_timeline"]);
        if (!Array.isArray(tl) || tl.length === 0) continue;

        let best = 0;
        for (const it of tl) {
            const n = _eg_pickNum((it as any)?.score) ?? _eg_pickNum((it as any)?.value);
            if (typeof n === "number" && n > best) best = n;
        }
        if (best > 0) return best;
    }

    return 0;
}

function pickTriggered(got0: any): boolean {
    const b = _eg_deepPickBool(got0, ["triggered", "isTriggered", "should_trigger", "shouldTrigger"]);
    return typeof b === "boolean" ? b : false;
}

function pickExpRisk(exp: any): string {
    return (
        pickStr(exp?.riskLevel) ||
        pickStr(exp?.risk) ||
        pickStr(exp?.risk_level) ||
        pickStr(exp?.riskLevelId) ||
        ""
    );
}

function pickExpStage(exp: any): string {
    return (
        pickStr(exp?.stagePeak) ||
        pickStr(exp?.stage_peak) ||
        pickStr(exp?.stagePeakId) ||
        pickStr(exp?.stage) ||
        pickStr(exp?.stageId) ||
        ""
    );
}

function pickExpTriggered(exp: any): boolean | undefined {
    const v = exp?.triggered ?? exp?.should_trigger ?? exp?.shouldTrigger ?? exp?.isTriggered;
    return typeof v === "boolean" ? v : undefined;
}

function pickExpScoreMin(exp: any): number | undefined {
    const n = exp?.score_min ?? exp?.scoreMin ?? exp?.score_minimum;
    const nn = Number(n);
    return Number.isFinite(nn) ? nn : undefined;
}

// ---- presets (하드코딩, 대회용 재현) ----
const ANCHORS_CORE_V2 = [
    "송금",
    "이체",
    "입금",
    "계좌",
    "계좌번호",
    "안전계좌",
    "보호계좌",
    "지급정지",
    "대포통장",
    "otp",
    "OTP",
    "오티피",
    "인증번호",
    "인증코드",
    "보안코드",
    "링크",
    "url",
    "URL",
    "설치",
    "앱",
    "원격",
    "팀뷰어",
    "AnyDesk",
    "애니데스크",
    "카드",
    "해외결제",
    "결제",
    "차단",
    "대출",
    "수수료",
];

// KO-2055/2112/2114류 방어용(의미 앵커에 준하는 키워드)
const ANCHORS_CORE_V4_EXTRA = [
    "보내",
    "보내줘",
    "보내주세요",
    "보내줘요",
    "보내 줘",
    "보내 주세요",
    "입금해",
    "이체해",
    "송금해",
    "보내달라",
    "이름",
    "연락처",
    "남겨",
    "남겨주세요",
    "남겨 주세요",
    "응모",
    "이벤트",
    "당첨",
    "당첨자",
    "고객센터",
    "상담",
    "상담이력",
    "확인용",
    "담당자",
    "센터",
    "생년월일",
];

const PRESETS: Record<string, Preset> = {
    fast200_v2: {
        preset: "fast200_v2",
        title: "200개 빠르게(앵커 고정, any)",
        targetKept: 200,
        nPerParent: 6,
        rounds: 3,
        topK: 30,
        minSimKeep: 0.78,
        minDistKeep: 0.08,
        maxDistKeep: 0.85,
        mode: "anchor_preserve",
        maskScope: "any",
        freezeKeywords: [...ANCHORS_CORE_V2],
        anchorTerms: [...ANCHORS_CORE_V2],
    },
    fast200_v4: {
        preset: "fast200_v4",
        title: "200개 빠르게(앵커+핵심키워드 보호: 보내/이벤트/고객센터/생년월일)",
        targetKept: 200,
        nPerParent: 6,
        rounds: 3,
        topK: 30,
        minSimKeep: 0.78,
        minDistKeep: 0.08,
        maxDistKeep: 0.85,
        mode: "anchor_preserve",
        maskScope: "any",
        freezeKeywords: [...ANCHORS_CORE_V2, ...ANCHORS_CORE_V4_EXTRA],
        anchorTerms: [...ANCHORS_CORE_V2, ...ANCHORS_CORE_V4_EXTRA],
    },
};

function getPreset(name: string): Preset | undefined {
    const key = String(name || "").trim();
    return key ? PRESETS[key] : undefined;
}

async function main() {
    const inPath = argStr("--in", "");
    const outPath = argStr("--out", "");
    if (!inPath || !outPath) {
        console.error("Usage: npx tsx tools/mutate_mlm.ts --in <golden.jsonl> --out <mutated.jsonl> [options]");
        process.exit(2);
    }

    const presetName = argStr("--preset", "");
    const preset = getPreset(presetName);

    const nPerParent = argNum("--n", preset?.nPerParent ?? 3);
    const limitParents = argNum("--limit", 0);

    const targetKept = argNum("--target", preset?.targetKept ?? 0);

    const seedBase = argNum("--seed", 12345);
    const rounds = argNum("--rounds", preset?.rounds ?? 2);
    const maskRatio = Number(arg("--mask") ?? "0.18");
    const topK = argNum("--topk", preset?.topK ?? 50);

    const model = argStr("--model", "Xenova/bert-base-multilingual-cased");
    const simModel = argStr("--sim-model", model);

    const minSimKeep = Number(arg("--min-sim") ?? String(preset?.minSimKeep ?? 0.78));
    const minDistKeep = Number(arg("--min-dist") ?? String(preset?.minDistKeep ?? 0.25));
    const maxDistKeep = arg("--max-dist")
        ? Number(arg("--max-dist"))
        : typeof preset?.maxDistKeep === "number"
            ? preset.maxDistKeep
            : undefined;

    type MutMode = "anchor_preserve" | "anchor_shake";
    const modeArg = arg("--mode");
    const mode: MutMode =
        modeArg === "anchor_shake"
            ? "anchor_shake"
            : modeArg === "anchor_preserve"
                ? "anchor_preserve"
                : (preset?.mode ?? "anchor_preserve");

    const isAnchorPreserve = mode === "anchor_preserve";
    const isAnchorShake = mode === "anchor_shake";

    const maskScopeArg = argStr("--mask-scope", preset ? preset.maskScope : "auto");
    const maskScope: MaskScope =
        maskScopeArg === "style"
            ? "style"
            : maskScopeArg === "any"
                ? "any"
                : isAnchorPreserve
                    ? "style"
                    : "any";

    const freezeKeywords =
        arg("--freeze-keywords")
            ? argList("--freeze-keywords")
            : preset?.freezeKeywords ?? [];
    const anchorTerms =
        arg("--anchor-terms")
            ? argList("--anchor-terms")
            : preset?.anchorTerms ?? [];

    const manifestPath = arg("--manifest");

    const cacheDir = arg("--cache");
    if (cacheDir) (env as any).cacheDir = cacheDir;

    await ensureDir(path.dirname(outPath));
    if (manifestPath) await ensureDir(path.dirname(manifestPath));

    const rows = await readJsonl(inPath);
    const parents = limitParents > 0 ? rows.slice(0, limitParents) : rows;

    const unmasker = await pipeline("fill-mask", model);
    const embedder = await createEmbedder(simModel, cacheDir);

    const embedCache = new Map<string, any>();
    async function embedCached(text: string) {
        const k = sha256utf8(text);
        const hit = embedCache.get(k);
        if (hit) return hit;
        const v = await embedder.embed(text);
        embedCache.set(k, v);
        return v;
    }

    let kept = 0;
    let dropped = 0;
    const dropReasons: Record<string, number> = {};
    const outLines: string[] = [];

    const useEngineGate = hasFlag("--engine-gate");

    // ✅ style에서 restore_mismatch 폭발 방지: 기본 no-freeze
    const globalNoFreeze = hasFlag("--no-freeze") || (maskScope === "style" && !hasFlag("--force-freeze"));

    // ✅ style에서 lex_too_similar 때문에 target 못 채우는 문제: 재시도
    const tries = argNum("--tries", maskScope === "style" ? 10 : 1);

    const configDigest = sha256utf8(
        JSON.stringify({
            preset: presetName || null,
            inPath,
            nPerParent,
            limitParents,
            targetKept,
            seedBase,
            rounds,
            maskRatio,
            topK,
            model,
            simModel,
            minSimKeep,
            minDistKeep,
            maxDistKeep,
            mode,
            maskScope,
            freezeKeywords,
            anchorTerms,
            engineGate: useEngineGate,
            noFreeze: globalNoFreeze,
            tries,
        })
    );

    for (const parent of parents) {
        if (targetKept > 0 && kept >= targetKept) break;

        const parentId = String(parent.id ?? "");
        const parentThread = String(parent.thread ?? "");
        if (!parentId || !parentThread) continue;

        const sr = splitSR(parentThread);
        const parentS = String(sr.sText ?? "");
        if (!parentS.trim()) continue;

        const preserveAnchors = hasFlag("--preserve-anchors") || isAnchorPreserve || maskScope === "style";
        const allowNewAnchors = hasFlag("--allow-new-anchors");
        const denySet = preserveAnchors && !allowNewAnchors ? buildDenyTokenSet(parentS, anchorTerms) : undefined;

        const parentVec = await embedCached(parentS);

        for (let j = 1; j <= nPerParent; j++) {
            if (targetKept > 0 && kept >= targetKept) break;

            const variantSeed =
                (seedBase +
                    sha256utf8(parentId)
                        .slice(0, 8)
                        .split("")
                        .reduce((a, c) => a + c.charCodeAt(0), 0) +
                    j) >>>
                0;

            let finalMutatedS = "";
            let finalSteps: any[] = [];
            let finalDist = 0;
            let finalSim = 0;

            let freezeEnabled = false;
            let freezeSpans: any[] = [];
            let restoredOk = true;
            let mismatchPlaceholders: string[] | undefined;

            let engineGateGot:
                | { risk?: string; stage?: string; score?: number; triggered?: boolean; payload?: string }
                | undefined;
            let engineGateExp: { risk?: string; stage?: string; score_min?: number; triggered?: boolean } | undefined;

            let added: string[] = [];
            let removed: string[] = [];

            let lastFail: string | undefined;

            for (let attempt = 0; attempt < Math.max(1, tries); attempt++) {
                const rng = makeRng(((variantSeed + attempt * 99991) >>> 0) as number);

                let steps: any[] = [];
                let mutatedS = "";
                let dist = 0;
                let sim = 0;

                // variant마다 noFreeze 고정(원하면 CLI로 강제 조정 가능)
                const noFreeze = globalNoFreeze;

                if (noFreeze) {
                    // <..._n>만 보호하고 MLM
                    const ph = protectAnglePlaceholders(parentS);
                    let working = detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(ph.text));

                    for (let r = 0; r < rounds; r++) {
                        const { masked, didMask } = maskOneToken(working, rng, maskScope);
                        if (!didMask) break;

                        steps.push({ op: "mask", mask_ratio: maskRatio, strategy: "token", masked: true, attempt });
                        const before = working;

                        const filled = await fillOneMask(unmasker, masked, topK, rng, denySet);
                        steps.push({ op: "fill", top_k: topK, filled: filled.filled, attempt });

                        if (!filled.filled) {
                            working = before;
                            break;
                        }
                        working = detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(filled.text));
                    }

                    const restored = unprotectAnglePlaceholders(working, ph.map);
                    mutatedS = detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(restored)).trim();

                    freezeEnabled = false;
                    freezeSpans = [];
                    restoredOk = true;
                    mismatchPlaceholders = undefined;
                } else {
                    // freeze/restore 경로
                    const freezeForThis = (isAnchorPreserve || useEngineGate) ? freezeKeywords : [];
                    const fr = freezeText(parentS, freezeForThis);

                    freezeEnabled = true;
                    freezeSpans = fr.spans;

                    let working = detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(fr.frozen));

                    for (let r = 0; r < rounds; r++) {
                        const { masked, didMask } = maskOneToken(working, rng, maskScope);
                        if (!didMask) break;

                        steps.push({ op: "mask", mask_ratio: maskRatio, strategy: "token", masked: true, attempt });
                        const before = working;

                        const filled = await fillOneMask(unmasker, masked, topK, rng, denySet);
                        steps.push({ op: "fill", top_k: topK, filled: filled.filled, attempt });

                        if (!filled.filled) {
                            working = before;
                            break;
                        }
                        working = detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(filled.text));
                    }

                    let rr = fr.restore(working);
                    if (!rr.restored_ok) {
                        rr = fr.restore(detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(working)));
                    }

                    restoredOk = !!rr.restored_ok;
                    mismatchPlaceholders = rr?.mismatch_placeholders;

                    if (!rr.restored_ok) {
                        lastFail = "restore_mismatch";
                        continue;
                    }

                    mutatedS = detachPunctFromPlaceholders(normalizeAnglePlaceholderSpacing(String(rr.restored ?? ""))).trim();
                }

                if (!mutatedS.trim()) {
                    lastFail = "empty_after_restore";
                    continue;
                }

                // anchor diff
                added = [];
                removed = [];
                if (anchorTerms.length) {
                    const a0 = new Set(anchorTerms.filter((t) => parentS.includes(t)));
                    const a1 = new Set(anchorTerms.filter((t) => mutatedS.includes(t)));
                    added = [...a1].filter((x) => !a0.has(x));
                    removed = [...a0].filter((x) => !a1.has(x));

                    if (preserveAnchors && (removed.length || added.length)) {
                        lastFail = removed.length ? "anchor_removed" : "anchor_added";
                        continue;
                    }
                }

                // lexical gate
                dist = jaccard3gramDistance(parentS, mutatedS);
                if (!(dist >= minDistKeep)) {
                    lastFail = "lex_too_similar";
                    continue;
                }
                if (typeof maxDistKeep === "number" && dist > maxDistKeep) {
                    lastFail = "lex_too_far";
                    continue;
                }

                // embedding gate
                const mutatedVec = await embedCached(mutatedS);
                sim = cosineSimNormalized(parentVec, mutatedVec);
                if (!(sim >= minSimKeep)) {
                    lastFail = "emb_sim_low";
                    continue;
                }

                const mutatedThread = rebuildThread(sr.lines, sr.sIdx, mutatedS);

                engineGateGot = undefined;
                engineGateExp = undefined;

                if (useEngineGate) {
                    try {
                        const exp = (parent as any).expected ?? {};
                        const expRisk = pickExpRisk(exp);
                        const expStage = pickExpStage(exp);
                        const expScoreMin = pickExpScoreMin(exp);
                        const expTriggered = pickExpTriggered(exp);

                        engineGateExp = {
                            risk: expRisk ? _eg_normStage(expRisk) : undefined,
                            stage: expStage ? _eg_normStage(expStage) : undefined,
                            score_min: typeof expScoreMin === "number" ? expScoreMin : undefined,
                            triggered: typeof expTriggered === "boolean" ? expTriggered : undefined,
                        };

                        const { got0, payloadName } = await analyzeThreadCompat(mutatedThread);

                        const gotRiskRaw = pickRiskId(got0);
                        const gotStageRaw = pickStageId(got0);
                        const gotScore = pickScoreTotal(got0);
                        const gotTriggered = pickTriggered(got0);

                        const gotRisk = gotRiskRaw ? _eg_normStage(gotRiskRaw) : "";
                        const gotStage = gotStageRaw ? _eg_normStage(gotStageRaw) : "";

                        engineGateGot = { risk: gotRisk, stage: gotStage, score: gotScore, triggered: gotTriggered, payload: payloadName };

                        const unparsed =
                            (engineGateExp.stage && !gotStage) ||
                            (engineGateExp.risk && !gotRisk) ||
                            (typeof engineGateExp.score_min === "number" && engineGateExp.score_min > 0 && gotScore === 0);

                        if (unparsed) {
                            lastFail = "engine_gate_unparsed";
                            await _dumpEngineGateOnce(String(parentId).replace(/[^\w\-]+/g, "_"), got0);

                            if (hasFlag("--engine-gate-strict")) {
                                continue;
                            }
                            // strict 아니면 keep(게이트 비교 스킵)
                        } else {
                            let gated = false;

                            if (engineGateExp.risk && gotRisk && gotRisk !== engineGateExp.risk) {
                                gated = true;
                                lastFail = "engine_gate_risk";
                            }
                            if (engineGateExp.stage && gotStage && gotStage !== engineGateExp.stage) {
                                gated = true;
                                lastFail = "engine_gate_stage";
                            }
                            if (typeof engineGateExp.score_min === "number" && gotScore < engineGateExp.score_min) {
                                gated = true;
                                lastFail = "engine_gate_score";
                            }
                            if (typeof engineGateExp.triggered === "boolean" && gotTriggered !== engineGateExp.triggered) {
                                gated = true;
                                lastFail = "engine_gate_trigger";
                            }

                            if (gated) continue;
                        }
                    } catch {
                        lastFail = "engine_gate_error";
                        continue;
                    }
                }

                // ✅ 이 attempt 성공: 확정
                finalMutatedS = mutatedS;
                finalSteps = steps;
                finalDist = dist;
                finalSim = sim;
                lastFail = undefined;
                break;
            }

            if (!finalMutatedS) {
                dropped++;
                const k = lastFail ?? "mutation_failed";
                dropReasons[k] = (dropReasons[k] ?? 0) + 1;
                continue;
            }

            const mutatedThread = rebuildThread(sr.lines, sr.sIdx, finalMutatedS);
            const mutatedId = `MUT-${parentId}-${String(j).padStart(4, "0")}`;

            const meta_mut: MutatedMetaV1 = {
                schema_version: "mutated.v1",
                track: "mutated",
                parent: {
                    parent_id: parentId,
                    parent_sha256_utf8: sha256utf8(parentThread),
                },
                freeze: {
                    policy_version: "freeze.v1",
                    enabled: freezeEnabled,
                    spans: freezeSpans,
                    verify: {
                        restored_ok: restoredOk,
                        mismatch_placeholders: mismatchPlaceholders,
                    },
                },
                mutation: {
                    generator: "mlm",
                    model: { name: model },
                    seed: variantSeed,
                    variant_no: j,
                    mode,
                    steps: finalSteps,
                    text_scope: { basis: "S_only", protected_placeholders: true },
                },
                gates: {
                    decision: "keep",
                    embedding: { model: simModel, sim: finalSim, min_sim_keep: minSimKeep },
                    lexical: {
                        metric: "jaccard_3gram",
                        distance: finalDist,
                        min_dist_keep: minDistKeep,
                        max_dist_keep: maxDistKeep,
                    },
                    anchors: {
                        preserve_expected: preserveAnchors,
                        diff: anchorTerms.length ? { added, removed } : undefined,
                    },
                    engine: useEngineGate ? { enabled: true, got: engineGateGot, exp: engineGateExp } : { enabled: false },
                },
                reproducibility: {
                    created_at: nowIsoKST(),
                    tool: { name: "mutate_mlm", version: "0.4.0" },
                    code: { git_commit: process.env.GIT_COMMIT },
                    config_digest: `sha256:${configDigest}`,
                    preset: presetName || undefined,
                },
            };

            const outRow: AnyRow = {
                id: mutatedId,
                thread: mutatedThread,
                expected: parent.expected,
                meta_mut,
            };

            outLines.push(JSON.stringify(outRow));
            kept++;
        }
    }

    await fs.writeFile(outPath, outLines.join("\n") + "\n", "utf8");

    const manifest = {
        schema_version: "mutated_manifest.v1",
        created_at: nowIsoKST(),
        input: inPath,
        output: outPath,
        stats: {
            parents_in: parents.length,
            n_per_parent: nPerParent,
            kept,
            dropped,
            drop_reasons: Object.entries(dropReasons)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => ({ reason, count })),
        },
        config_digest: `sha256:${configDigest}`,
        models: { mlm: model, embed: simModel },
        options: {
            preset: presetName || null,
            mode,
            mask_scope: maskScope,
            engine_gate: useEngineGate,
            engine_gate_strict: hasFlag("--engine-gate-strict"),
            target_kept: targetKept,
            no_freeze: globalNoFreeze,
            tries,
        },
        known_presets: Object.keys(PRESETS),
    };

    if (manifestPath) {
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    } else {
        console.log(JSON.stringify(manifest, null, 2));
    }

    console.log(`OK: wrote ${kept} mutated rows -> ${outPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
