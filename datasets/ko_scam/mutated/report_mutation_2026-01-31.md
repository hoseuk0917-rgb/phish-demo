# Mutation Failure Report
- created_at: 2026-01-31T11:44:42.695Z
- fails: C:\projects\phish-demo\datasets\ko_scam\mutated\mutated_2026-01-31_mlmv1_fails.jsonl
- dataset: C:\projects\phish-demo\datasets\ko_scam\mutated\mutated_2026-01-31_mlmv1.jsonl
- total_fails: 36

## By reason
- score_below_min: 25
- risk_mismatch: 19
- stage_mismatch: 19

## Risk pairs (top 15)
- high → high: 9
- low → low: 8
- high → low: 7
- medium → low: 7
- high → medium: 5

## Stage pairs (top 15)
- verify → info: 10
- verify → verify: 9
- payment → info: 8
- payment → payment: 8
- payment → verify: 1

## Score delta (expected_min - gotScore)
- count: 25
- min: 2
- p50: 14
- p90: 31
- max: 41
- avg: 17.64

## Top parents (top 15)
- KO-2094_e3v2: 3  (avg_score_delta=37.67)
  - examples: MUT-KO-2094_e3v2-0001, MUT-KO-2094_e3v2-0002, MUT-KO-2094_e3v2-0003
- KO-2114_e3v1: 3  (avg_score_delta=8)
  - examples: MUT-KO-2114_e3v1-0001, MUT-KO-2114_e3v1-0002, MUT-KO-2114_e3v1-0003
- KO-2114_e3v3: 3  (avg_score_delta=11.33)
  - examples: MUT-KO-2114_e3v3-0001, MUT-KO-2114_e3v3-0002, MUT-KO-2114_e3v3-0003
- KO-2037_e3v1: 2  (avg_score_delta=18)
  - examples: MUT-KO-2037_e3v1-0001, MUT-KO-2037_e3v1-0002
- KO-2037_e3v2: 2  (avg_score_delta=18)
  - examples: MUT-KO-2037_e3v2-0001, MUT-KO-2037_e3v2-0002
- KO-2037_e3v3: 2  (avg_score_delta=12)
  - examples: MUT-KO-2037_e3v3-0001, MUT-KO-2037_e3v3-0003
- KO-2094_e3v1: 2  (avg_score_delta=36)
  - examples: MUT-KO-2094_e3v1-0001, MUT-KO-2094_e3v1-0002
- BENIGN_0002_e3v1: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0002_e3v1-0003
- BENIGN_0002_e3v3: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0002_e3v3-0003
- BENIGN_0006_e3v2: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0006_e3v2-0002
- BENIGN_0006_e3v3: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0006_e3v3-0002
- BENIGN_0010_e3v2: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0010_e3v2-0001
- BENIGN_0018_e3v3: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0018_e3v3-0003
- BENIGN_0022_e3v3: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0022_e3v3-0001
- BENIGN_0050_e3v2: 1  (avg_score_delta=n/a)
  - examples: MUT-BENIGN_0050_e3v2-0003

## Embedding clusters (sim >= 0.86)
- model: Xenova/bert-base-multilingual-cased
- C001: size=36 avgSim=0.9745 rep=MUT-KO-2031_e3v1-0001
  - top_reasons: score_below_min(25), risk_mismatch(19), stage_mismatch(19)
  - top_parents: KO-2094_e3v2(3), KO-2114_e3v1(3), KO-2114_e3v3(3), KO-2037_e3v1(2), KO-2037_e3v2(2)

