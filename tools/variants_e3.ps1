param(
  [Parameter(Mandatory = $true)][string]$InPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$K = 3,
  [int]$Seed = 42,
  [switch]$IncludeOriginal,
  [switch]$MutateR
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Set-Meta($o) {
  # meta 속성 자체가 없으면 생성
  if ($null -eq $o.PSObject.Properties["meta"]) {
    $o | Add-Member -NotePropertyName meta -NotePropertyValue ([pscustomobject]@{}) -Force
    return
  }
  # meta가 null이면 빈 객체로
  if ($null -eq $o.meta) {
    $o.meta = [pscustomobject]@{}
    return
  }
  # meta가 dictionary면 pscustomobject로 정규화
  if ($o.meta -is [System.Collections.IDictionary]) {
    $m = [pscustomobject]@{}
    foreach ($k in $o.meta.Keys) {
      $m | Add-Member -NotePropertyName ([string]$k) -NotePropertyValue $o.meta[$k] -Force
    }
    $o.meta = $m
  }
}

function Set-Note([object]$obj, [string]$name, [object]$value) {
  if ($null -eq $obj) { return }

  if ($obj -is [System.Collections.IDictionary]) {
    $obj[$name] = $value
    return
  }

  $prop = $obj.PSObject.Properties[$name]
  if ($null -ne $prop) {
    $obj.$name = $value
  }
  else {
    $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
  }
}

function Select-One([System.Random]$rng, $arr) {
  if (-not $arr -or $arr.Count -le 0) { return $null }
  return $arr[$rng.Next(0, $arr.Count)]
}

function New-DeterministicRandom([string]$key) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [Text.Encoding]::UTF8.GetBytes($key)
  $hash = $sha.ComputeHash($bytes)
  $seed32 = [BitConverter]::ToInt32($hash, 0)
  return (New-Object System.Random ($seed32))
}

function Edit-EndingKo([string]$s, [System.Random]$rng, [switch]$RStrict) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $s }

  # ✅ RStrict: "단어 치환 금지" + "문장부호/공백만" 변형
  if ($RStrict) {
    # URL 뒤에 붙은 문장부호 제거(안전)
    $s = $s -replace '(https?://[^\s"\\]+)[\.\!\?…]+(?=(\s|$))', '$1'

    # 끝 문장부호만 가볍게 변형(의미변형 방지: ?/! 는 유지)
    if ($rng.NextDouble() -lt 0.70) {
      $t = $s.TrimEnd()
      if ($t -match '[\?\!]$') {
        # 질문/강조는 그대로 둠
      }
      elseif ($t -match '[\.\…]$') {
        $core = $t -replace '[\.\…]+$', ''
        $t = $core + (Select-One $rng @('.', '…', ''))
        $s = $t
      }
      elseif ($t -notmatch '[\.\!\?…]$') {
        $s = $t + (Select-One $rng @('.', '…', ''))
      }
    }

    # 최소 정규화(공백 중복 제거)
    $s = ($s -replace '\s{2,}', ' ').Trim()
    return $s
  }

  # =========================
  # 아래는 기존(S 변형) 로직 유지
  # =========================

  # 공손/요청 톤 변형
  if ($rng.NextDouble() -lt 0.85) {
    $s = $s -replace '바랍니다', (Select-One $rng @('부탁드립니다', '요청드립니다', '해주세요', '해주시기 바랍니다'))
    $s = $s -replace '요청드립니다', (Select-One $rng @('요청드려요', '부탁드립니다', '요청합니다'))
    $s = $s -replace '부탁드립니다', (Select-One $rng @('부탁드려요', '부탁합니다', '부탁드립니다'))
  }

  # 확인/응대 문장 변형
  if ($rng.NextDouble() -lt 0.70) {
    $s = $s -replace '확인\s*부탁드립니다', (Select-One $rng @('확인 부탁드려요', '확인 부탁합니다', '확인 부탁드립니다'))
    $s = $s -replace '확인\s*해주세요', (Select-One $rng @('확인해 주세요', '확인 부탁드립니다', '확인해주세요'))
    $s = $s -replace '확인\s*바랍니다', (Select-One $rng @('확인 부탁드립니다', '확인 바랍니다', '확인해 주세요'))
  }

  # ✅ R에서 자주 나오는 “순응/진행” 표현 변형(중복 치환 방지)
  if ($rng.NextDouble() -lt 0.80) {
    $didConfirm = $false

    # "확인할게요/확인할께요"를 먼저 처리하고, 뒤에서 "할게요" 재치환을 막음
    if ($s -match '확인할(게요|께요)') {
      $didConfirm = $true
      $s = $s -replace '확인할(게요|께요)', (Select-One $rng @(
          '확인해볼게요',
          '확인하겠습니다',
          '지금 확인해볼게요',
          '바로 확인하겠습니다'
        ))
    }

    # 일반 "할게요/할께요"는 접미 변형만(앞단 부사 금지: 확인바로 같은 붙어쓰기 방지)
    if (-not $didConfirm) {
      $s = $s -replace '할(게요|께요)', (Select-One $rng @('해볼게요', '하겠습니다', '할게요'))
    }

    $s = $s -replace '할게', (Select-One $rng @('해볼게', '하겠어', '할게'))
    $s = $s -replace '알겠습니다', (Select-One $rng @('네 알겠습니다', '알겠어요', '확인했습니다', '네', '예'))
    $s = $s -replace '네\s*$', (Select-One $rng @('네', '예', '넵', '알겠어요'))
  }

  # 말투/종결형 약간 변형
  if ($rng.NextDouble() -lt 0.55) {
    $s = $s -replace '하십시오', (Select-One $rng @('하세요', '해주시기 바랍니다', '해주셔야 합니다'))
    $s = $s -replace '합니다', (Select-One $rng @('합니다', '해요', '합니다'))
  }

  # 끝 문장부호(겹치지 않게)
  if ($rng.NextDouble() -lt 0.55) {
    if ($s -notmatch '[\.\!\?…]$') {
      $s = $s.TrimEnd() + (Select-One $rng @('.', '!', '…', ''))
    }
  }

  # 최소 정규화(공백 중복 제거)
  $s = ($s -replace '\s{2,}', ' ').Trim()

  return $s
}

function Edit-Thread([string]$thread, [System.Random]$rng, [switch]$MutateR) {
  if ([string]::IsNullOrWhiteSpace($thread)) { return $thread }

  $lines = $thread -split "`r?`n"

  # 정책:
  # - 기본: S만 변형, R는 원문 유지
  # - -MutateR: R만 변형, S는 원문 유지
  $mutateS = -not $MutateR.IsPresent
  $mutateR = $MutateR.IsPresent

  $out = foreach ($ln in $lines) {
    if ($ln -match '^(S:)\s*(.*)$') {
      if ($mutateS) {
        $p = $matches[1]
        $body = $matches[2]
        "$p $(Edit-EndingKo $body $rng)"
      }
      else {
        $ln
      }
    }
    elseif ($ln -match '^(R:)\s*(.*)$') {
      if ($MutateR) {
        $p = $matches[1]
        $body = $matches[2]
        "$p $(Edit-EndingKo $body $rng -RStrict)"
      }
      else {
        $ln
      }
    }
    else {
      $ln
    }
  }

  return ($out -join "`n")
}

function DeepCopy($o) {
  return ($o | ConvertTo-Json -Depth 100) | ConvertFrom-Json
}

if (-not (Test-Path $InPath)) { throw "INPUT NOT FOUND: $InPath" }

$dir = Split-Path -Parent $OutPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$buf = New-Object System.Collections.Generic.List[string]
$lines = Get-Content -LiteralPath $InPath -Encoding utf8

foreach ($line in $lines) {
  if (-not $line.Trim()) { continue }
  $o = $line | ConvertFrom-Json

  $baseId = if ($null -ne $o.PSObject.Properties["id"]) { [string]$o.id } else { [Guid]::NewGuid().ToString("N") }

  if ($IncludeOriginal) {
    $o0 = DeepCopy $o
    Set-Meta $o0
    Set-Note $o0.meta "variant_type" "base"
    Set-Note $o0.meta "variant_idx" 0
    Set-Note $o0.meta "base_id" $baseId
    $buf.Add(($o0 | ConvertTo-Json -Depth 100 -Compress))
  }

  for ($vi = 1; $vi -le $K; $vi++) {
    $o2 = DeepCopy $o
    Set-Meta $o2

    $rng = New-DeterministicRandom ("{0}|{1}|{2}" -f $Seed, $baseId, $vi)

    if ($null -ne $o2.PSObject.Properties["thread"]) {
      $o2.thread = Edit-Thread ([string]$o2.thread) $rng -MutateR:$MutateR
    }

    if ($null -ne $o2.PSObject.Properties["id"]) {
      $o2.id = "{0}_e3v{1}" -f $baseId, $vi
    }
    else {
      $o2 | Add-Member -NotePropertyName id -NotePropertyValue ("{0}_e3v{1}" -f $baseId, $vi) -Force
    }

    Set-Note $o2.meta "variant_type" "ending_e3"
    Set-Note $o2.meta "variant_idx" $vi
    Set-Note $o2.meta "base_id" $baseId
    Set-Note $o2.meta "variant_seed" $Seed

    $buf.Add(($o2 | ConvertTo-Json -Depth 100 -Compress))
  }
}

$buf | Set-Content -Encoding utf8 -LiteralPath $OutPath
"[variants] wrote=$($buf.Count) out=$OutPath"

