import fs from "node:fs";

const P="datasets/ko_scam/mutated/out_nonlow_fast_expected_ui.jsonl";
const ID="MUT-SC00093-0001";

const lines = fs.readFileSync(P,"utf8").split(/\r?\n/).filter(Boolean);
let changed = 0;

const out = lines.map((l) => {
  const row = JSON.parse(l);

  if (row?.id === ID) {
    row.meta = row.meta ?? {};
    row.meta.score_min_prev = row?.expected?.score_min;

    row.expected = row.expected ?? {};
    // low 케이스는 score_min 강제 조건을 제거(또는 0)
    delete row.expected.score_min;
    // row.expected.score_min = 0;

    changed++;
  }

  return JSON.stringify(row);
});

fs.writeFileSync(P, out.join("\n") + "\n", "utf8");
console.log("OK patched:", changed, "->", P);
