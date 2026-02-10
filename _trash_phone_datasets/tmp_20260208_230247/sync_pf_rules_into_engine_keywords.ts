import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

type PfRule = { id: string; label?: string; regexes: string[] };

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
    return process.argv.includes(name);
}

function listFilesRec(dir: string): string[] {
    const out: string[] = [];
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFilesRec(p));
        else if (e.isFile() && p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
    return out;
}

function getProp(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
    for (const p of obj.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const name = p.name;
        if (ts.isIdentifier(name) && name.text === key) return p.initializer;
        if (ts.isStringLiteral(name) && name.text === key) return p.initializer;
    }
    return undefined;
}

function readStringLiteral(e?: ts.Expression): string | undefined {
    if (!e) return undefined;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    return undefined;
}

function readRegexLiteral(e: ts.Expression): string | undefined {
    // /.../gi 형태
    if (ts.isRegularExpressionLiteral(e)) return e.text;

    // new RegExp("...", "gi") / RegExp("...", "gi")
    if (ts.isNewExpression(e) || ts.isCallExpression(e)) {
        const expr = (e as ts.NewExpression | ts.CallExpression).expression;
        const name =
            ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : "";
        if (name !== "RegExp") return undefined;

        const args = (e as ts.NewExpression | ts.CallExpression).arguments ?? [];
        const pat = readStringLiteral(args[0]);
        const flags = readStringLiteral(args[1]) ?? "";
        if (!pat) return undefined;

        // 안전하게 literal로 재구성
        return `/${pat.replace(/\//g, "\\/")}/${flags}`;
    }

    return undefined;
}

function uniq(arr: string[]): string[] {
    const s = new Set(arr.map((x) => x.trim()).filter(Boolean));
    return Array.from(s);
}

// PF → 엔진 ruleId 매핑(여기만 늘리면 “전체 자동 동기화”)
const PF_TO_ENGINE: Record<string, string[]> = {
    pf_authority: ["authority"],
    pf_urgency: ["urgent"],
    pf_messenger_profile: ["ctx_contact_move"],
    pf_benefit_hook: ["ctx_government_benefit"],
    pf_account_verify: ["account_verify"],
    pf_transfer: ["transfer"],
    pf_threat: ["threat"],
    pf_pii: ["personalinfo"],
    pf_link_verbs: ["link", "shortener"],
    pf_otp: ["otp"],
    pf_otp_demand: ["ctx_otp_relay", "ctx_otp_proxy", "ctx_otp_finance_relay"],
    pf_cash_pickup: ["ctx_cash_pickup"],
    pf_visit_place: ["ctx_visit_place", "visit_place", "go_bank_atm"],
};

function inferEngineIds(pfId: string, existingEngineIds: Set<string>): string[] {
    const mapped = PF_TO_ENGINE[pfId];
    if (mapped?.length) return mapped.filter((x) => existingEngineIds.has(x));

    // fallback: pf_xxx → xxx 가 엔진에 있으면 그걸로
    const base = pfId.replace(/^pf_/, "");
    if (existingEngineIds.has(base)) return [base];

    // urgency → urgent 관용
    if (base === "urgency" && existingEngineIds.has("urgent")) return ["urgent"];

    return [];
}

function extractPfRulesFromFile(filePath: string): PfRule[] {
    const code = fs.readFileSync(filePath, "utf8");
    const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const out: PfRule[] = [];

    function visit(n: ts.Node) {
        if (ts.isObjectLiteralExpression(n)) {
            const id = readStringLiteral(getProp(n, "id"));
            if (id && id.startsWith("pf_")) {
                const label = readStringLiteral(getProp(n, "label"));

                const regexes: string[] = [];

                const patterns = getProp(n, "patterns");
                if (patterns && ts.isArrayLiteralExpression(patterns)) {
                    for (const el of patterns.elements) {
                        const r = readRegexLiteral(el as ts.Expression);
                        if (r) regexes.push(r);
                    }
                }

                const pattern = getProp(n, "pattern") ?? getProp(n, "re");
                if (pattern) {
                    const r = readRegexLiteral(pattern);
                    if (r) regexes.push(r);
                }

                out.push({ id, label, regexes: uniq(regexes) });
            }
        }
        ts.forEachChild(n, visit);
    }

    visit(sf);
    return out;
}

function parseEngineIdsFromKeywords(engineText: string): Set<string> {
    const ids = new Set<string>();
    const re = /id:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(engineText))) ids.add(m[1]);
    return ids;
}

function patchPatternsBlock(lines: string[], startIdx: number, addRegexes: string[]): { changed: boolean } {
    // startIdx는 `id: "xxx"` 라인
    let patternsIdx = -1;
    for (let i = startIdx; i < Math.min(lines.length, startIdx + 120); i++) {
        if (lines[i].includes("patterns:")) {
            patternsIdx = i;
            break;
        }
    }
    if (patternsIdx < 0) return { changed: false };

    // 배열 시작 '[' 찾기
    let arrStart = -1;
    for (let i = patternsIdx; i < Math.min(lines.length, patternsIdx + 10); i++) {
        if (lines[i].includes("[")) {
            arrStart = i;
            break;
        }
    }
    if (arrStart < 0) return { changed: false };

    // 배열 끝 ']' 찾기 (단순 depth)
    let depth = 0;
    let arrEnd = -1;
    for (let i = arrStart; i < Math.min(lines.length, arrStart + 400); i++) {
        const l = lines[i];
        for (const ch of l) {
            if (ch === "[") depth++;
            else if (ch === "]") depth--;
        }
        if (depth === 0 && i > arrStart) {
            arrEnd = i;
            break;
        }
    }
    if (arrEnd < 0) return { changed: false };

    const existing = new Set<string>();
    for (let i = arrStart; i <= arrEnd; i++) {
        const t = lines[i].trim();
        if (t.startsWith("/") && t.includes("/") && t.endsWith(",")) {
            existing.add(t.replace(/,\s*$/, ""));
        }
    }

    const toAdd = addRegexes
        .map((r) => r.trim())
        .filter(Boolean)
        .filter((r) => !existing.has(r));

    if (!toAdd.length) return { changed: false };

    const indent = (lines[arrStart + 1] ?? "      /x/gi,").match(/^\s*/)?.[0] ?? "      ";
    const insertAt = arrEnd; // 닫히기 직전
    const insertLines = toAdd.map((r) => `${indent}${r},`);

    lines.splice(insertAt, 0, ...insertLines);
    return { changed: true };
}

async function main() {
    const pfDir = arg("--pf-dir") || "./src/engine/prefilter";
    const engineKeywords = arg("--engine") || "./src/engine/rules/keywords.ts";
    const outPath = arg("--out") || "./tmp/keywords.ts.pf_sync.new";
    const dry = flag("--dry");

    if (!fs.existsSync(pfDir)) throw new Error(`missing pf dir: ${pfDir}`);
    if (!fs.existsSync(engineKeywords)) throw new Error(`missing engine file: ${engineKeywords}`);

    const engineText = fs.readFileSync(engineKeywords, "utf8");
    const engineIds = parseEngineIdsFromKeywords(engineText);

    const pfFiles = listFilesRec(pfDir);
    const pfRulesAll: PfRule[] = [];
    for (const f of pfFiles) pfRulesAll.push(...extractPfRulesFromFile(f));

    const pfById = new Map<string, PfRule>();
    for (const r of pfRulesAll) {
        if (!r.regexes.length) continue;
        const prev = pfById.get(r.id);
        if (!prev) pfById.set(r.id, r);
        else pfById.set(r.id, { ...prev, regexes: uniq([...prev.regexes, ...r.regexes]) });
    }

    const lines = engineText.split("\n");
    let changed = false;

    const summary: Array<{ pfId: string; engineIds: string[]; n: number }> = [];

    for (const [pfId, pf] of Array.from(pfById.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const targets = inferEngineIds(pfId, engineIds);
        if (!targets.length) continue;

        for (const engId of targets) {
            const idx = lines.findIndex((l) => l.includes(`id: "${engId}"`));
            if (idx < 0) continue;

            const res = patchPatternsBlock(lines, idx, pf.regexes);
            if (res.changed) {
                changed = true;
                summary.push({ pfId, engineIds: [engId], n: pf.regexes.length });
            }
        }
    }

    if (dry) {
        console.log(`pf_rules=${pfById.size} engine_ids=${engineIds.size} changed=${changed ? "yes" : "no"}`);
        console.log(`patched_targets=${summary.length}`);
        for (const x of summary.slice(0, 30)) console.log(`- ${x.pfId} -> ${x.engineIds.join(",")} (+patterns)`);
        return;
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join("\n"), "utf8");

    console.log(`wrote -> ${outPath} changed=${changed ? "yes" : "no"}`);
    console.log(`pf_rules=${pfById.size} patched_targets=${summary.length}`);
    for (const x of summary.slice(0, 50)) console.log(`- ${x.pfId} -> ${x.engineIds.join(",")} (merged)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
