export type MutatePreset = {
    name: string;
    desc: string;

    // generation knobs
    target?: number;        // stop after kept >= target
    n?: number;             // variants per parent (max tries per parent loop)
    rounds?: number;
    topk?: number;
    maskScope?: "any" | "style";

    // gates
    minSim?: number;
    minDist?: number;
    maxDist?: number;

    // policy
    mode?: "anchor_preserve" | "anchor_shake";
    freezeKeywords?: string[];
    anchorTerms?: string[];
};

const ANCHORS_V2 = [
    "송금", "이체", "입금", "계좌", "계좌번호", "안전계좌", "보호계좌", "지급정지", "대포통장",
    "otp", "OTP", "오티피", "인증번호", "인증코드", "보안코드",
    "링크", "url", "URL", "설치", "앱", "원격", "팀뷰어", "AnyDesk", "anydesk", "애니데스크",
    "카드", "해외결제", "결제", "차단",
    "대출", "수수료",
];

export const PRESETS: Record<string, MutatePreset> = {
    // ✅ 네가 방금 성공시킨 fast200_v2를 그대로 “하드코딩” 프리셋으로 박아둔 버전
    fast200_v2: {
        name: "fast200_v2",
        desc: "target=200, n=6, rounds=3, topk=30, minSim=0.78, minDist=0.08, maxDist=0.85, anchor_preserve + anchors only",
        target: 200,
        n: 6,
        rounds: 3,
        topk: 30,
        maskScope: "any",
        minSim: 0.78,
        minDist: 0.08,
        maxDist: 0.85,
        mode: "anchor_preserve",
        freezeKeywords: ANCHORS_V2,
        anchorTerms: ANCHORS_V2,
    },

    // ✅ “드리프트(urgent/social/authority만 남는)” 케이스를 더 줄이고 싶으면 이걸 써
    //    (다양성은 조금 줄지만 pass 안정성은 올라감)
    fast200_v2_strict: {
        name: "fast200_v2_strict",
        desc: "fast200_v2 + extra guard tokens (urgent/social/authority-ish) to reduce drift",
        target: 200,
        n: 6,
        rounds: 3,
        topk: 30,
        maskScope: "any",
        minSim: 0.78,
        minDist: 0.08,
        maxDist: 0.85,
        mode: "anchor_preserve",
        freezeKeywords: [
            ...ANCHORS_V2,
            // drift guards (너가 fail에서 본 urgent/social/authority 축)
            "긴급", "급히", "즉시", "바로", "당장",
            "카톡", "카카오", "문자", "전화", "연락",
            "경찰", "검찰", "금감원", "수사", "고객센터", "센터", "담당자",
        ],
        anchorTerms: [
            ...ANCHORS_V2,
            "긴급", "급히", "즉시", "바로", "당장",
            "카톡", "카카오", "문자", "전화", "연락",
            "경찰", "검찰", "금감원", "수사", "고객센터", "센터", "담당자",
        ],
    },
};
