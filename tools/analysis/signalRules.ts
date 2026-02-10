// tools/analysis/signalRules.ts
export type SignalKind = "channel" | "action" | "lure" | "entity";

export type Rule = {
    id: string;
    label: string;
    kind: SignalKind;
    patterns: RegExp[];
};

const rx = (s: string, flags = "i") => new RegExp(s, flags);

// ✅ 필요하면 여기만 계속 확장하면 됨(룰 추가/패턴 추가)
export const RULES: Rule[] = [
    // -------- channel --------
    {
        id: "ch_sms",
        label: "문자/SMS",
        kind: "channel",
        patterns: [rx("문자|SMS|스미싱|메시지")],
    },
    {
        id: "ch_kakao",
        label: "카카오톡",
        kind: "channel",
        patterns: [rx("카카오|카톡|KakaoTalk|오픈채팅")],
    },
    {
        id: "ch_telegram",
        label: "텔레그램",
        kind: "channel",
        patterns: [rx("텔레그램|Telegram")],
    },
    {
        id: "ch_phone",
        label: "전화/통화",
        kind: "channel",
        patterns: [rx("전화|통화|발신|수신|보이스피싱|ARS")],
    },
    {
        id: "ch_email",
        label: "이메일",
        kind: "channel",
        patterns: [rx("이메일|메일|email|e-mail")],
    },

    // -------- action --------
    {
        id: "ac_install",
        label: "앱 설치 유도",
        kind: "action",
        patterns: [
            rx("설치(해|하)라|앱\\s*설치|설치\\s*링크|다운로드(\\s*링크)?|APK|구글\\s*플레이|플레이\\s*스토어"),
        ],
    },
    {
        id: "ac_remote",
        label: "원격제어 유도",
        kind: "action",
        patterns: [
            rx("원격|원격제어|화면\\s*공유|리모트|AnyDesk|TeamViewer|QuickSupport|RustDesk|HelpDesk"),
        ],
    },
    {
        id: "ac_otp",
        label: "OTP/인증번호 요구",
        kind: "action",
        patterns: [rx("OTP|인증\\s*번호|보안\\s*코드|인증코드|6자리\\s*코드|문자\\s*인증")],
    },
    {
        id: "ac_transfer",
        label: "송금/이체 요구",
        kind: "action",
        patterns: [
            rx("송금|이체|계좌|입금|가상\\s*계좌|대포\\s*통장|현금\\s*인출|수수료\\s*입금|보증금"),
        ],
    },
    {
        id: "ac_link_click",
        label: "링크 클릭 유도",
        kind: "action",
        patterns: [rx("링크\\s*클릭|접속\\s*하(세|시)요|URL|클릭\\s*해(보|주)세요")],
    },
    {
        id: "ac_personal_info",
        label: "개인정보 요구",
        kind: "action",
        patterns: [
            rx("주민번호|신분증|계좌\\s*번호|비밀번호|카드\\s*번호|CVV|인증서|공인\\s*인증|개인정보"),
        ],
    },

    // -------- lure --------
    {
        id: "lu_parcel",
        label: "택배/배송",
        kind: "lure",
        patterns: [rx("택배|배송|운송장|CJ|한진|로젠|우체국|대한통운|보관\\s*기간")],
    },
    {
        id: "lu_job",
        label: "취업/알바",
        kind: "lure",
        patterns: [rx("채용|면접|입사|연봉|알바|부업|재택|구인|HR|인사\\s*팀")],
    },
    {
        id: "lu_bank",
        label: "금융/대출/카드",
        kind: "lure",
        patterns: [rx("대출|저금리|한도|상환|연체|신용|카드\\s*발급|금리|금융")],
    },
    {
        id: "lu_gov",
        label: "기관 사칭",
        kind: "lure",
        patterns: [rx("검찰|경찰|금감원|국세청|법원|수사\\s*관|사건\\s*번호|출석\\s*요구")],
    },
    {
        id: "lu_crypto",
        label: "코인/투자",
        kind: "lure",
        patterns: [rx("코인|가상자산|거래소|지갑\\s*주소|투자\\s*리딩|수익\\s*보장|상장\\s*정보")],
    },

    // -------- entity --------
    {
        id: "en_bank_names",
        label: "은행/카드사 키워드",
        kind: "entity",
        patterns: [rx("국민|신한|우리|하나|농협|기업|SC|씨티|카카오뱅크|토스뱅크|삼성카드|현대카드")],
    },
    {
        id: "en_platforms",
        label: "플랫폼 키워드",
        kind: "entity",
        patterns: [rx("네이버|Naver|카카오|Kakao|구글|Google|애플|Apple|쿠팡|배달")],
    },
];

export const URL_RX = /https?:\/\/[^\s)]+/gi;

// 대략적인 도메인/짧은 URL도 잡기(과탐 가능하면 꺼도 됨)
export const DOMAIN_LIKE_RX = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?\b/gi;

// 한국/국제 전화번호(과탐 줄이려면 stricter로 조정)
export const PHONE_RX = /\b(?:0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}|\+\d{1,3}[-\s]?\d{1,4}[-\s]?\d{3,4}[-\s]?\d{4})\b/g;

// 금액(원/만원/달러 등)
export const MONEY_RX =
    /\b\d{1,3}(?:,\d{3})+(?:\s*(?:원|KRW|₩|만원|달러|USD|\$))?\b|\b\d+(?:\s*(?:원|만원|달러|USD|\$))\b/gi;

export function cleanText(s: string): string {
    return (s || "")
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
