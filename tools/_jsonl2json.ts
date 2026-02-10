import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
};

const IN = get("--in");
const OUT = get("--out");

if (!IN || !OUT) {
    console.error("Usage: npx tsx tools/_jsonl2json.ts --in <in.jsonl> --out <out.json>");
    process.exit(2);
}

const lines = fs.readFileSync(IN, "utf8").split(/\r?\n/).filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + "\n", "utf8");
console.log("OK:", OUT, "rows", rows.length);
