import fs from "node:fs/promises";
import path from "node:path";

function stripComments(s: string) {
    return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function braceBlockAround(src: string, at: number): string | null {
    let start = -1;
    for (let k = at; k >= 0; k--) {
        if (src[k] === "{") { start = k; break; }
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

function extractRegexLiterals(src: string): string[] {
    const s = stripComments(src);
    const re = /\/(?:\\.|[^\/\n])+\/[gimsuy]*/g;
    return s.match(re) || [];
}

function mergeRegex(existing: string[], extra: string[]): string[] {
    const norm = (x: string) => x.replace(/\s+/g, "");
    const seen = new Set(existing.map(norm));
    const out = [...existing];
    for (const r of extra) {
        const k = norm(r);
        if (!seen.has(k)) { seen.add(k); out.push(r); }
    }
    return out;
}

function replacePatternsBlock(objBlock: string, extraRegex: string[]): string {
    const m = objBlock.match(/patterns\s*:\s*\[\s*([\s\S]*?)\s*\]\s*,?/m);
    if (!m) return objBlock;

    const inside = m[1] ?? "";
    const existing = extractRegexLiterals(inside);
    const merged = mergeRegex(existing, extraRegex);

    // indent 추정
    const line = inside.split("\n").find((l) => l.trim().length > 0) || "      /x/gi";
    const indent = line.match(/^\s*/)?.[0] ?? "      ";
    const closeIndent = indent.slice(0, Math.max(0, indent.length - 2));

    const body = `\n${merged.map((r) => `${indent}${r},`).join("\n")}\n${closeIndent}`;
    return objBlock.replace(/patterns\s*:\s*\[\s*[\s\S]*?\s*\]\s*,?/m, `patterns: [${body}],`);
}

function insertRuleBeforeFinalArrayClose(kwSrc: string, newRuleObj: string): string {
    const idx = kwSrc.lastIndexOf("\n];");
    if (idx < 0) throw new Error("Cannot find final '\\n];' to insert before.");
    return kwSrc.slice(0, idx) + "\n\n" + newRuleObj.trimEnd() + "\n" + kwSrc.slice(idx);
}

async function main() {
    const keywordFile = path.join("src", "engine", "rules", "keywords.ts");
    const outFile = path.join("tmp", "keywords.ts.contact_move_plus.new");

    let kwSrc = await fs.readFile(keywordFile, "utf8");

    const engineId = "ctx_contact_move";
    const hardAdd = [
        // 메신저/프로필/오픈채팅/DM 등 “맥락 토큰” 넓게
        /(카카오\s*톡|카톡|kakao\s*talk|오픈\s*채팅|오픈채팅|채팅방|대화방|텔레그램|telegram|라인|line|메신저|dm|디엠|프로필|아이디|id)/gi,

        // “프로필 확인/조회/눌러보기/링크” 류
        /(프로필|아이디|id).*(확인|조회|보라|봐|보세요|체크|눌러|들어가|접속)/gi,

        // “메신저로 이동/전환/연락/친추/추가” 류
        /((카톡|텔레그램|라인|메신저).*(추가|친추|친구\s*추가|아이디\s*검색|연락|문의|이동|전환|옮기|넘어오))/gi,
    ].map((r) => r.toString()); // 리터럴 문자열로 삽입

    const blk = findObjectBlockByIdLiteral(kwSrc, engineId);

    if (blk) {
        const newBlk = replacePatternsBlock(blk, hardAdd);
        kwSrc = kwSrc.replace(blk, newBlk);
    } else {
        const newRuleObj = `  {
    id: "${engineId}",
    label: "메신저/프로필/연락처 이동 맥락",
    stage: "info",
    weight: 1,
    patterns: [
      ${hardAdd.join("\n      ")}
    ],
  },`;
        kwSrc = insertRuleBeforeFinalArrayClose(kwSrc, newRuleObj);
    }

    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(outFile, kwSrc, "utf8");
    console.log(`wrote -> ${outFile}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
