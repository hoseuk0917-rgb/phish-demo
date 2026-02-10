import fs from "node:fs/promises";
import path from "node:path";

function stripComments(s: string) {
    return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.isFile() && p.endsWith(".ts")) out.push(p);
    }
    return out;
}

function extractRegexLiterals(src: string): string[] {
    const s = stripComments(src);
    const re = /\/(?:\\.|[^\/\n])+\/[gimsuy]*/g;
    const all = s.match(re) || [];
    const norm = (x: string) => x.replace(/\s+/g, "");
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of all) {
        const k = norm(r);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(r);
        }
    }
    return out;
}

function braceBlockAround(src: string, at: number): string | null {
    let start = -1;
    for (let k = at; k >= 0; k--) {
        if (src[k] === "{") {
            start = k;
            break;
        }
    }
    if (start < 0) return null;

    let depth = 0;
    for (let k = start; k < src.length; k++) {
        const ch = src[k];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return src.slice(start, k + 1);
        }
    }
    return null;
}

function findObjectBlockByIdLiteral(src: string, id: string): string | null {
    const needle = new RegExp(`\\bid\\s*:\\s*["'\`]${id}["'\`]`, "m");
    const m = needle.exec(src);
    if (!m) return null;
    return braceBlockAround(src, m.index);
}

function extractPatternsArray(block: string): { inside: string; indent: string } | null {
    const m = block.match(/patterns\s*:\s*\[\s*([\s\S]*?)\s*\]\s*,?/m);
    if (!m) return null;
    const inside = m[1] ?? "";
    const line = inside.split("\n").find((l) => l.trim().length > 0) || "";
    const indent = line.match(/^\s*/)?.[0] ?? "      ";
    return { inside, indent };
}

function mergeRegex(existing: string[], extra: string[]): string[] {
    const norm = (x: string) => x.replace(/\s+/g, "");
    const seen = new Set(existing.map(norm));
    const out = [...existing];
    for (const r of extra) {
        const k = norm(r);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(r);
        }
    }
    return out;
}

function replacePatternsBlock(objBlock: string, extraRegex: string[]): string {
    const parts = extractPatternsArray(objBlock);
    if (!parts) return objBlock;

    const existing = extractRegexLiterals(parts.inside);
    const merged = mergeRegex(existing, extraRegex);

    const indent = parts.indent;
    const closeIndent = indent.slice(0, Math.max(0, indent.length - 2));
    const body = `\n${merged.map((r) => `${indent}${r},`).join("\n")}\n${closeIndent}`;

    return objBlock.replace(/patterns\s*:\s*\[\s*[\s\S]*?\s*\]\s*,?/m, `patterns: [${body}],`);
}

function insertRuleBeforeFinalArrayClose(kwSrc: string, newRuleObj: string): string {
    const idx = kwSrc.lastIndexOf("\n];");
    if (idx < 0) throw new Error("Cannot find final '\\n];' to insert before. keywords.ts structure changed.");
    return kwSrc.slice(0, idx) + "\n\n" + newRuleObj.trimEnd() + "\n" + kwSrc.slice(idx);
}

function countHits(lit: string, tokens: string[]) {
    let n = 0;
    for (const t of tokens) if (lit.includes(t)) n++;
    return n;
}

async function main() {
    const prefilterDir = path.join("src", "engine", "prefilter");
    const keywordFile = path.join("src", "engine", "rules", "keywords.ts");

    // ✅ PF 쪽에서 “확장된 문구”를 정규식 리터럴로 긁어올 토큰들
    const AUTH_STRONG = ["검찰", "지검", "검사", "경찰", "수사관", "형사", "금감원", "금융감독원", "수사"];
    const AUTH_WEAK = ["은행", "카드사", "고객센터", "담당자", "센터", "창구"];

    const MSG_TOKENS = [
        "메신저",
        "카카오",
        "카톡",
        "Kakao",
        "텔레그램",
        "Telegram",
        "라인",
        "Line",
        "오픈채팅",
        "채팅",
        "대화방",
        "프로필",
        "아이디",
        "ID",
        "친추",
        "추가",
        "톡",
        "DM",
    ];

    const pfFiles = await walk(prefilterDir);

    const allRegex: string[] = [];
    for (const f of pfFiles) {
        const src = await fs.readFile(f, "utf8");
        allRegex.push(...extractRegexLiterals(src));
    }

    // ✅ authority 후보: strong 1개 이상 OR weak 2개 이상
    const authRegex = allRegex.filter((r) => countHits(r, AUTH_STRONG) >= 1 || countHits(r, AUTH_WEAK) >= 2);

    // ✅ messenger/profile 후보
    const msgRegex = allRegex.filter((r) => countHits(r, MSG_TOKENS) >= 1);

    // 중복 제거(정규화)
    const uniq = (arr: string[]) => {
        const norm = (x: string) => x.replace(/\s+/g, "");
        const seen = new Set<string>();
        const out: string[] = [];
        for (const a of arr) {
            const k = norm(a);
            if (!seen.has(k)) {
                seen.add(k);
                out.push(a);
            }
        }
        return out;
    };

    const authUniq = uniq(authRegex);
    const msgUniq = uniq(msgRegex);

    let kwSrc = await fs.readFile(keywordFile, "utf8");
    const originalKw = kwSrc;

    // A) PF authority bucket → engine "authority" 룰 patterns 병합
    {
        const engineId = "authority";
        const blk = findObjectBlockByIdLiteral(kwSrc, engineId);
        if (!blk) throw new Error(`[ERR] engine rule not found in keywords.ts: id=${engineId}`);
        const newBlk = replacePatternsBlock(blk, authUniq);
        kwSrc = kwSrc.replace(blk, newBlk);
    }

    // B) PF messenger bucket → engine "ctx_contact_move" 룰 병합 (없으면 새로 추가)
    {
        const engineId = "ctx_contact_move";
        const blk = findObjectBlockByIdLiteral(kwSrc, engineId);

        if (blk) {
            const newBlk = replacePatternsBlock(blk, msgUniq);
            kwSrc = kwSrc.replace(blk, newBlk);
        } else {
            const newRuleObj = `  {
    id: "${engineId}",
    label: "메신저/프로필/연락처 이동 맥락",
    stage: "info",
    weight: 1,
    patterns: [
${msgUniq.map((r) => `      ${r},`).join("\n")}
    ],
  },`;
            kwSrc = insertRuleBeforeFinalArrayClose(kwSrc, newRuleObj);
        }
    }

    await fs.mkdir("tmp", { recursive: true });
    const outNew = path.join("tmp", "keywords.ts.new");
    await fs.writeFile(outNew, kwSrc, "utf8");

    console.log(`wrote -> ${outNew} changed=${kwSrc !== originalKw ? "yes" : "no"}`);
    console.log(`[PF regex bucket] authority=${authUniq.length} messenger=${msgUniq.length}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
