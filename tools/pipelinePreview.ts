// tools/pipelinePreview.ts
import path from "node:path";
import fs from "node:fs/promises";
import { crawlCounterscam } from "./corpus/crawlCounterscam";

type Source = {
    slug: string;
    kind: "counterscam_board";
    list_url: string;
    detail_path_contains: string;
    page_param?: string;
};

function parseArgs(argv: string[]) {
    const args: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

async function readJson<T>(filePath: string): Promise<T> {
    const buf = await fs.readFile(filePath, "utf8");
    return JSON.parse(buf) as T;
}

async function main() {
    const a = parseArgs(process.argv.slice(2));
    const pages = Number(a["pages"] ?? 2);
    const sleepMs = Number(a["sleep"] ?? 150);
    const noAttach = Boolean(a["no-attach"]);
    const targetsArg = String(a["targets"] ?? "").trim();

    const defaultTargets = ["counterscam_press", "counterscam_alert"];
    const targets = targetsArg ? targetsArg.split(",").map((s) => s.trim()).filter(Boolean) : defaultTargets;

    const attach = !noAttach;

    console.log(
        `[PIPELINE PREVIEW] targets=${targets.join(", ")} pages=${pages} sleep=${sleepMs}ms attach=${attach}`
    );

    const regPath = path.join(process.cwd(), "corpus", "registry", "sources.json");
    const reg = await readJson<{ sources: Source[] }>(regPath);

    for (const slug of targets) {
        const source = reg.sources.find((s) => s.slug === slug);
        if (!source) {
            console.log(`- ${slug}: missing in registry`);
            continue;
        }

        const res = await crawlCounterscam(source as any, {
            maxPages: Number.isFinite(pages) ? pages : 2,
            sleepMs: Number.isFinite(sleepMs) ? sleepMs : 150,
            downloadAttachments: attach,
            attachExisting: false, // ✅ 추가: preview는 기본적으로 기존 item 재다운로드 안 함
            userAgent: "phish-demo-corpus-bot/1.0 (+local demo; contact: none)",
        });

        console.log(`- ${slug}: newItems=${res.newItems}, newFiles=${res.newFiles}`);
    }

    console.log("[OK] pipeline preview done.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
