import fs from "node:fs";

function read(p: string): string[] {
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length);
}

// usage: npx tsx tools/_mergeJsonl.ts <outPath> <in1> <in2> ...
const outPath = process.argv[2];
const ins = process.argv.slice(3);

if (!outPath || ins.length === 0) {
  console.log("usage: npx tsx tools/_mergeJsonl.ts <outPath> <in1> <in2> ...");
  process.exit(2);
}

const merged: string[] = [];
for (const p of ins) merged.push(...read(String(p)));

fs.writeFileSync(String(outPath), merged.join("\n") + "\n", "utf8");
console.log({ outPath, lines: merged.length, inputs: ins.length });
