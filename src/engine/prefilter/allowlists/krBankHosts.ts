// src/engine/prefilter/allowlists/krBankHosts.ts
// 데모용 "공식 도메인 suffix" 시드.
// 실서비스에서는 업데이트 루프/레지스트리로 분리 권장.

export const KR_BANK_HOST_SUFFIXES: string[] = [
    // 시중/특수
    "kbstar.com",
    "wooribank.com",
    "shinhan.com",
    "kebhana.com",
    "hanabank.com",
    "ibk.co.kr",
    "nonghyup.com",
    "sc.co.kr",
    "standardchartered.co.kr",
    "citibank.co.kr",

    // 지방
    "busanbank.co.kr",
    "knbank.co.kr",
    "imbank.co.kr",
    "dgb.co.kr",
    "jbbank.co.kr",
    "kjbank.com",
    "jejubank.co.kr",

    // 인뱅
    "kakaobank.com",
    "tossbank.com",
    "kbanknow.com",
];

// 은행은 아니지만 피싱에서 “금융기관처럼” 자주 등장하는 범주(옵션)
export const KR_FI_EXTRA_HOST_SUFFIXES: string[] = [
    "epost.go.kr", // 우체국(금융/보험/우편)
    "cu.co.kr",    // 신협
    "kfcc.co.kr",  // 새마을금고
];
