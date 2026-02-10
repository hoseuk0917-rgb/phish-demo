// tools/analysis/repairAttachmentNames.ts
import fs from "node:fs/promises";
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

async function fileExists(p: string) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function walk(dir: string, acc: string[]) {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            await walk(p, acc);
        } else {
            acc.push(p);
        }
    }
}

function hasExt(name: string) {
    return /\.[a-z0-9]{1,6}$/i.test(name.trim());
}

function baseNameFromSavedAs(saved_as: string) {
    const s = String(saved_as || "").trim();
    if (!s) return "";
    const parts = s.split(/[\\/]/g);
    return (parts[parts.length - 1] || "").trim();
}

function looksMojibake(s: string) {
    const t = String(s ?? "");
    if (!t) return false;

    const rep = (t.match(/\uFFFD/g) ?? []).length;
    const q = (t.match(/\?/g) ?? []).length;
    const hangul = (t.match(/[가-힣]/g) ?? []).length;
    const cjk = (t.match(/[\u4E00-\u9FFF]/g) ?? []).length;

    // 강한 시그널
    if (rep > 0) return true;
    if (q >= 6 && hangul === 0) return true;

    // 한국어가 0인데 CJK가 꽤 많으면(“蹂댁씠…”류)
    if (hangul === 0 && cjk >= 4) return true;

    return false;
}

function isGenericName(s: string) {
    const t = String(s ?? "").trim().toLowerCase();
    if (!t) return true;
    return (
        t === "attachment" ||
        t === "download" ||
        t === "nd_filedownload" ||
        t.startsWith("attachment_") ||
        t.startsWith("download_")
    );
}

function replaceAllSafe(hay: string, needle: string, repl: string) {
    if (!hay || !needle || needle === repl) return hay;
    // split/join이 제일 안전
    return hay.split(needle).join(repl);
}

async function main() {
    const args = parseArgs(process.argv);

    const root = path.resolve(String(args.root || "./corpus/derived/normalized"));
    const dryRun = Boolean(args["dry-run"]);
    const verbose = Boolean(args.verbose);

    if (!(await fileExists(root))) {
        console.error(`ERROR: --root not found: ${root}`);
        process.exit(1);
    }

    const all: string[] = [];
    await walk(root, all);

    const jsonFiles = all.filter((p) => p.toLowerCase().endsWith(".json"));
    let filesTouched = 0;
    let namesFixed = 0;

    for (const fp of jsonFiles) {
        let raw = "";
        let doc: any;
        try {
            raw = await fs.readFile(fp, "utf8");
            doc = JSON.parse(raw);
        } catch {
            continue;
        }

        if (!doc || typeof doc !== "object") continue;
        if (!Array.isArray(doc.attachments) || doc.attachments.length === 0) continue;

        let changed = false;

        for (const a of doc.attachments) {
            if (!a || typeof a !== "object") continue;

            const oldName = String(a.name ?? "");
            const savedAs = String(a.saved_as ?? "");
            if (!savedAs) continue;

            const bn = baseNameFromSavedAs(savedAs);
            if (!bn) continue;

            // saved_as가 확장자를 가지고 있으면 우선 신뢰
            const candidate = hasExt(bn) ? bn : bn;

            // name이 깨졌거나/너무 일반이면 saved_as 기준으로 교체
            if (looksMojibake(oldName) || isGenericName(oldName)) {
                if (oldName !== candidate) {
                    a.name = candidate;
                    namesFixed++;
                    changed = true;

                    // title/body_text 안에 oldName이 그대로 박혀 있으면 같이 치환
                    if (typeof doc.title === "string" && doc.title.includes(oldName)) {
                        doc.title = replaceAllSafe(doc.title, oldName, candidate);
                    }
                    if (typeof doc.body_text === "string" && doc.body_text.includes(oldName)) {
                        doc.body_text = replaceAllSafe(doc.body_text, oldName, candidate);
                    }

                    if (verbose) {
                        console.log(`[FIX_NAME] ${path.relative(root, fp).replace(/\\/g, "/")} :: "${oldName}" -> "${candidate}"`);
                    }
                }
            }
        }

        if (changed) {
            filesTouched++;
            if (!dryRun) {
                await fs.writeFile(fp, JSON.stringify(doc, null, 2) + "\n", "utf8");
            }
        }
    }

    console.log(`json_scanned: ${jsonFiles.length}`);
    console.log(`files_touched: ${filesTouched}${dryRun ? " (dry-run)" : ""}`);
    console.log(`names_fixed: ${namesFixed}`);
    console.log(`root: ${root}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
