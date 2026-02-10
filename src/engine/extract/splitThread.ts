function isHeaderLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;

  // [오전 10:21] ... (카톡 스타일)
  if (/^\[\s*(오전|오후)?\s*\d{1,2}:\d{2}\s*\]/.test(s)) return true;

  // 2026-01-14 10:21 / 2026.01.14 오후 3:21
  if (/^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s+(오전|오후)?\s*\d{1,2}:\d{2}/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return true;

  // 오전 10:21 홍길동: ...
  if (/^(오전|오후)?\s*\d{1,2}:\d{2}\s+.{1,40}:\s*/.test(s)) return true;

  // 10:21 홍길동: ...
  if (/^\d{1,2}:\d{2}\s+.{1,40}:\s*/.test(s)) return true;

  return false;
}

export type SpeakerTag = "S" | "R" | "U";

function parseSpeakerPrefix(line: string): { speaker: SpeakerTag; rest: string } | null {
  const s = line.trimStart();

  // S: ... / R: ...
  const m1 = s.match(/^(S|R)\s*:\s*(.*)$/i);
  if (m1) {
    const who = String(m1[1] || "").toUpperCase() === "R" ? "R" : "S";
    return { speaker: who as SpeakerTag, rest: String(m1[2] || "") };
  }

  // sender:/receiver:/발신:/수신:
  const m2 = s.match(/^(sender|receiver|발신|수신)\s*:\s*(.*)$/i);
  if (m2) {
    const head = String(m2[1] || "").toLowerCase();
    const who: SpeakerTag = head === "receiver" || head === "수신" ? "R" : "S";
    return { speaker: who, rest: String(m2[2] || "") };
  }

  return null;
}

function extractHeaderSpeakerLabel(line: string): string | null {
  const s = line.trim();

  // 오전 10:21 홍길동: ...
  let m = s.match(/^(오전|오후)?\s*\d{1,2}:\d{2}\s+(.{1,40}?):\s*/);
  if (m) return String(m[2] || "").trim() || null;

  // 10:21 홍길동: ...
  m = s.match(/^\d{1,2}:\d{2}\s+(.{1,40}?):\s*/);
  if (m) return String(m[1] || "").trim() || null;

  // [오전 10:21] 홍길동: ...
  m = s.match(/^\[\s*(오전|오후)?\s*\d{1,2}:\d{2}\s*\]\s*(.{1,40}?):\s*/);
  if (m) return String(m[2] || "").trim() || null;

  // 2026-01-14 10:21 홍길동: ...
  m = s.match(/^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s+(오전|오후)?\s*\d{1,2}:\d{2}\s+(.{1,40}?):\s*/);
  if (m) return String(m[2] || "").trim() || null;

  return null;
}

export type ThreadBlockRange = {
  text: string;
  start: number; // textarea value 기준 인덱스
  end: number; // newline 제외, 마지막 라인 끝 인덱스

  // ✅ 추가 메타(기존 사용처는 무시해도 됨)
  speaker?: SpeakerTag; // S(발신) / R(수신) / U(unknown)
  speakerLabel?: string; // 헤더에서 뽑힌 “홍길동” 같은 표시용 이름(매핑은 다음 단계)
};

export type SplitThreadOptions = {
  // UI 토글을 “원문을 바꾸지 않고” split에만 반영
  turnPrefixMode?: boolean;
  autoPrefixMode?: boolean;
  defaultWho?: "S" | "R";
};

export function splitThreadWithRanges(thread: string, opts?: SplitThreadOptions): ThreadBlockRange[] {
  const original = thread ?? "";
  const text = original.replace(/\r\n/g, "\n");
  if (!text.trim()) return [];

  const turnPrefixMode = !!opts?.turnPrefixMode;
  const autoPrefixMode = !!opts?.autoPrefixMode;
  const autoOn = turnPrefixMode && autoPrefixMode;

  const defaultWho: SpeakerTag = (opts?.defaultWho || "S") === "R" ? "R" : "S";

  const lines = text.split("\n");

  const out: ThreadBlockRange[] = [];
  let curLines: string[] = [];
  let curStart = -1;
  let curEnd = -1;
  let curSpeaker: SpeakerTag = "U";
  let curSpeakerLabel: string | undefined = undefined;

  const flush = () => {
    const joined = curLines.join("\n").trim();
    if (joined) {
      out.push({
        text: joined,
        start: curStart,
        end: curEnd,
        speaker: curSpeaker,
        speakerLabel: curSpeakerLabel,
      });
    }
    curLines = [];
    curStart = -1;
    curEnd = -1;
    curSpeaker = "U";
    curSpeakerLabel = undefined;
  };

  let pos = 0; // 현재 라인 시작 인덱스
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineStart = pos;
    const lineEnd = pos + rawLine.length; // newline 제외
    pos = lineEnd + 1; // 다음 라인(개행 1)

    const trimmed = rawLine.trim();

    // 빈 줄은 강제 분리
    if (!trimmed) {
      flush();
      continue;
    }

    const line = rawLine.replace(/\s+$/g, "");
    const lineTrim = line.trim();

    const sp0 = parseSpeakerPrefix(lineTrim);
    const sp = sp0 ?? (autoOn ? { speaker: defaultWho, rest: lineTrim } : null);

    const isSpeakerLine = !!sp;
    const headerSpeakerLabel = isHeaderLine(lineTrim) ? extractHeaderSpeakerLabel(lineTrim) : null;

    // ✅ S:/R: 라인이면 새 메시지 시작(현재 블록이 있으면 flush)
    if (isSpeakerLine && curLines.length > 0) {
      flush();
    }

    // 헤더 라인이면 새 메시지 시작(현재 블록이 있으면 flush)
    if (isHeaderLine(lineTrim) && curLines.length > 0) {
      flush();
    }

    if (curLines.length === 0) {
      curStart = lineStart;

      // ✅ 블록 시작 시 speaker 추정
      if (sp) {
        curSpeaker = sp.speaker;
      } else {
        curSpeaker = "U";
      }

      // ✅ 헤더에서 이름이 잡히면 보관(아직 S/R 매핑은 다음 단계)
      if (headerSpeakerLabel) curSpeakerLabel = headerSpeakerLabel;
    }

    curLines.push(line);
    curEnd = lineEnd;
  }

  flush();

  return out.slice(0, 200);
}

export function splitThread(thread: string, opts?: SplitThreadOptions): string[] {
  return splitThreadWithRanges(thread, opts).map((b) => b.text);
}
