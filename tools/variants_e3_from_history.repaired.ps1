$in  = ".\datasets\ko_scam\scenarios_ko_v4_eval_engineAligned.jsonl"
$out = ".\datasets\ko_scam\scenarios_ko_v4_eval_engineAligned_variants_e3.jsonl"
$k = 3
$seed = 42
$rng = [System.Random]::new($seed)
function PickOne($arr) { $arr[$rng.Next(0, $arr.Count)] }
function EnsureMeta($obj) {`
  if (-not $obj.meta) {`
    $obj | Add-Member -NotePropertyName meta -NotePropertyValue ([pscustomobject]@{}) -Force`
  } elseif ($obj.meta -is [hashtable]) {`
    $obj.meta = [pscustomobject]$obj.meta`
  }`
}
function SetMeta($obj, [string]$name, $value) {`
  EnsureMeta $obj`
  $obj.meta | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force`
}
function MutateEndingKo([string]$s) {`
  if ([string]::IsNullOrWhiteSpace($s)) { return $s }`
  if ($rng.NextDouble() -lt 0.85) {`
    $s = $s -replace "부탁드립니다", (PickOne @("부탁드려요","부탁합니다","부탁드릴게요","부탁 좀 드립니다","부탁해요"))`
    $s = $s -replace "바랍니다", (PickOne @("부탁드립니다","요청드립니다","해주세요","해주시면 됩니다"))`
    $s = $s -replace "요청드립니다", (PickOne @("요청드려요","부탁드립니다","요청합니다"))`
  }`
  if ($rng.NextDouble() -lt 0.90) {`
    $s = $s -replace "해\s*주세요", (PickOne @("해주세요","해주시면 됩니다","해주셔야 합니다","해주시기 바랍니다"))`
    $s = $s -replace "확인\s*부탁드립니다", (PickOne @("확인 부탁드려요","확인 부탁합니다","확인 바랍니다","확인 좀 부탁드려요"))`
    $s = $s -replace "확인\s*해주세요", (PickOne @("확인해 주세요","확인 부탁드립니다","확인 바랍니다","확인해주시면 됩니다"))`
    $s = $s -replace "하십시오", (PickOne @("하세요","해주시기 바랍니다","해주셔야 합니다"))`
  }`
  if ($rng.NextDouble() -lt 0.50) {`
    $s = ($s -replace "\s+", " ").Trim()`
    if ($rng.NextDouble() -lt 0.30) { $s = $s + (PickOne @(".","!","…",".")) }`
  }`
  return $s`
}
function MutateTyposKo([string]$s) {`
  if ([string]::IsNullOrWhiteSpace($s)) { return $s }`
  if ($rng.NextDouble() -lt 0.35) {`
    $s = $s -replace "해주(세요|세요)", (PickOne @("해주세여","해주세용","해주쎄요","해주세요"))`
    $s = $s -replace "부탁드려요", (PickOne @("부탁드려용","부탁드려욤","부탁드려요"))`
    $s = $s -replace "감사합니다", (PickOne @("감사합니당","감사합니다","고맙습니다"))`
  }`
  $kwRules = @(`
    @{ pat="인증번호"; reps=@("인증 번호","인증번호","인증번 오") },`
    @{ pat="OTP"; reps=@("O T P","O.T.P","오티피","otp") },`
    @{ pat="송금"; reps=@("송 금","송굼","송금") },`
    @{ pat="계좌"; reps=@("계 좌","게좌","계좌") },`
    @{ pat="원격"; reps=@("원 격","원걱","원격") },`
    @{ pat="설치"; reps=@("설 치","설치") },`
    @{ pat="링크"; reps=@("링 크","린크","링크") },`
    @{ pat="URL"; reps=@("U R L","url","URL") }`
  )`
  if ($rng.NextDouble() -lt 0.65) {`
    $rule = PickOne $kwRules`
    $s = $s -replace $rule.pat, (PickOne $rule.reps)`
  }`
  return $s`
}
function IsSenderRole($role) {`
  if (-not $role) { return $false }`
  $r = [string]$role`
  return ($r -eq "S" -or $r -match "sender|scam|attacker|bot|agent")`
}
function PickSenderTurnIndexes($turns) {`
  $idx = @()`
  for ($t=0; $t -lt $turns.Count; $t++) {`
    if (IsSenderRole $turns[$t].role) { $idx += $t }`
  }`
  return $idx`
}
$rows = New-Object System.Collections.Generic.List[string]
$rows | Set-Content -Encoding utf8 $out
"[variants] wrote=$($rows.Count) out=$out"
