import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const dataPath = process.argv[2];
const id = process.argv[3];

if (!dataPath || !id) {
    console.log("usage: npx tsx tools/_showHits.ts <jsonlPath> <idSubstring>");
    process.exit(2);
}

const line = fs
    .readFileSync(String(dataPath), "utf8")
    .split(/\r?\n/)
    .find((l) => l.includes(String(id)));

if (!line) throw new Error("not found");

const row: any = JSON.parse(line);
const thread = String(row.thread ?? row.threadText ?? "");

const res = await analyzeThread({ threadText: thread } as any);

console.log({
    scoreTotal: (res as any)?.scoreTotal,
    risk: (res as any)?.riskLevel,
    triggered: Boolean((res as any)?.triggered),
    hitsTopLen: ((res as any)?.hitsTop ?? []).length,
});

console.log(
    "hitsTop:",
    ((res as any)?.hitsTop ?? []).slice(0, 20).map((h: any) => ({
        ruleId: h.ruleId,
        stage: h.stage,
        w: h.weight,
    }))
);
