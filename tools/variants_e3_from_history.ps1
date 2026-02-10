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
    $s = $s -replace "遺?곷뱶由쎈땲??, (PickOne @("遺?곷뱶?ㅼ슂","遺?곹빀?덈떎","遺?곷뱶由닿쾶??,"遺??醫 ?쒕┰?덈떎","遺?곹빐??))`
    $s = $s -replace "諛붾엻?덈떎", (PickOne @("遺?곷뱶由쎈땲??,"?붿껌?쒕┰?덈떎","?댁＜?몄슂","?댁＜?쒕㈃ ?⑸땲??))`
    $s = $s -replace "?붿껌?쒕┰?덈떎", (PickOne @("?붿껌?쒕젮??,"遺?곷뱶由쎈땲??,"?붿껌?⑸땲??))`
  }`
  if ($rng.NextDouble() -lt 0.90) {`
    $s = $s -replace "??s*二쇱꽭??, (PickOne @("?댁＜?몄슂","?댁＜?쒕㈃ ?⑸땲??,"?댁＜?붿빞 ?⑸땲??,"?댁＜?쒓린 諛붾엻?덈떎"))`
    $s = $s -replace "?뺤씤\s*遺?곷뱶由쎈땲??, (PickOne @("?뺤씤 遺?곷뱶?ㅼ슂","?뺤씤 遺?곹빀?덈떎","?뺤씤 諛붾엻?덈떎","?뺤씤 醫 遺?곷뱶?ㅼ슂"))`
    $s = $s -replace "?뺤씤\s*?댁＜?몄슂", (PickOne @("?뺤씤??二쇱꽭??,"?뺤씤 遺?곷뱶由쎈땲??,"?뺤씤 諛붾엻?덈떎","?뺤씤?댁＜?쒕㈃ ?⑸땲??))`
    $s = $s -replace "?섏떗?쒖삤", (PickOne @("?섏꽭??,"?댁＜?쒓린 諛붾엻?덈떎","?댁＜?붿빞 ?⑸땲??))`
  }`
  if ($rng.NextDouble() -lt 0.50) {`
    $s = ($s -replace "\s+", " ").Trim()`
    if ($rng.NextDouble() -lt 0.30) { $s = $s + (PickOne @(".","!","??,".")) }`
  }`
  return $s`
}
function MutateTyposKo([string]$s) {`
  if ([string]::IsNullOrWhiteSpace($s)) { return $s }`
  if ($rng.NextDouble() -lt 0.35) {`
    $s = $s -replace "?댁＜(?몄슂|?몄슂)", (PickOne @("?댁＜?몄뿬","?댁＜?몄슜","?댁＜?꾩슂","?댁＜?몄슂"))`
    $s = $s -replace "遺?곷뱶?ㅼ슂", (PickOne @("遺?곷뱶?ㅼ슜","遺?곷뱶?ㅼ슕","遺?곷뱶?ㅼ슂"))`
    $s = $s -replace "媛먯궗?⑸땲??, (PickOne @("媛먯궗?⑸땲??,"媛먯궗?⑸땲??,"怨좊쭥?듬땲??))`
  }`
  $kwRules = @(`
    @{ pat="?몄쬆踰덊샇"; reps=@("?몄쬆 踰덊샇","?몄쬆踰덊샇","?몄쬆踰???) },`
    @{ pat="OTP"; reps=@("O T P","O.T.P","?ㅽ떚??,"otp") },`
    @{ pat="?↔툑"; reps=@("??湲?,"?↔돔","?↔툑") },`
    @{ pat="怨꾩쥖"; reps=@("怨?醫?,"寃뚯쥖","怨꾩쥖") },`
    @{ pat="?먭꺽"; reps=@("??寃?,"?먭굇","?먭꺽") },`
    @{ pat="?ㅼ튂"; reps=@("??移?,"?ㅼ튂") },`
    @{ pat="留곹겕"; reps=@("留???,"由고겕","留곹겕") },`
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
