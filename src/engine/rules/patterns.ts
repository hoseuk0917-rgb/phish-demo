import { WEIGHTS } from "./weights";
import type { Rule } from "./keywords";

export const PATTERN_RULES: Rule[] = [
  {
    id: "link",
    label: "URL 포함",
    stage: "verify",
    weight: WEIGHTS.link,
    patterns: [
      /https?:\/\/(?!drive\.google\.com\b)(?!docs\.google\.com\b)(?!github\.com\b)(?![^/\s)]*intranet\b)[^\s)]+/gi,
    ],
  },
  {
    id: "shortener",
    label: "단축 URL",
    stage: "verify",
    weight: WEIGHTS.shortener,
    patterns: [/(bit\.ly|t\.co|tinyurl|me2\.do|han\.gl)/gi],
  },
  {
    id: "apk",
    label: "APK/설치파일 유도",
    stage: "install",
    weight: WEIGHTS.installRemote,
    patterns: [/(\.apk\b|\bapk\b|프로파일\s*설치|뷰어\s*설치|다운로드|다운\s*받)/gi],
  },

  {
    id: "ctx_pay_with_link",
    label: "결제/승인/알림 + 확인 링크(검증 단계)",
    stage: "verify",
    weight: WEIGHTS.threat,
    patterns: [
      /(결제|이체|송금|승인|카드).{0,24}(알림|설정|확인|차단|해제|보안|보호).{0,40}https?:\/\//gi,
      /(알림\s*설정|설정\s*확인|확인\s*링크|차단\s*처리).{0,40}https?:\/\//gi,
    ],
  },

  {
    id: "ctx_transfer_phrase",
    label: "금액/송금/입금 직접 요구(보내줘/부쳐줘/충전)",
    stage: "payment",
    weight: WEIGHTS.money,
    patterns: [
      /(\d[\d,]{1,}\s*(만\s*)?원).{0,20}(보내|보내줘|부쳐|부쳐줘|송금|이체|입금|납부)/gi,
      /(보내|부쳐|송금|이체|입금|납부).{0,20}(\d[\d,]{1,}\s*(만\s*)?원)/gi,
      /(입금|충전).{0,20}(만\s*하면|하면\s*시작|후\s*시작|하면\s*됩니다|하면\s*돼)/gi,
    ],
  },
];
