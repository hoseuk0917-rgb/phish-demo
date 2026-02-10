import { prefilterThread } from "../src/engine/prefilter/prefilter.ts";

const cases:[string,string][] = [
  ["prosecutor_police_impersonation","S: 검찰입니다. 사건 관련 출석 바랍니다. 지금 2번출구로 와주세요"],
  ["safe_case","S: 안전계좌로 자금보호 진행합니다. 안내계좌로 이체해주세요"],
  ["bank_impersonation","S: KB국민은행 보안팀입니다. OTP 알려주세요"],
  ["account_seizure","S: 계좌가 동결될 수 있어요. 링크로 본인확인 진행하세요"],
  ["delivery_phishing","S: 택배 반송건 확인: http://t.co/xxxx 주소확인 필요"],
  ["government_subsidy","S: 지원금 대상자입니다. 신청 링크에서 계좌 입력"],
  ["invoice_tax","S: 전자고지 미납입니다. 링크로 납부"],
  ["loan_scam","S: 저금리 대출 가능합니다. 수수료 먼저 입금"],
  ["family_emergency","S: 엄마 나 급해. 지금 30만원만 이체해줘"],
  ["romance_investment","S: 리딩방 초대합니다. 텔레그램으로 이동"],
  ["job_highpay_abroad","S: 고수익 알바. 오픈채팅으로 이동 후 교육장 방문"],
  ["messenger_phishing","S: (카톡) 프로필 확인해줘 링크 클릭"],
  ["gifticon_market","S: 상품권 핀번호 보내주시면 매입해드려요"],
];

for (const [k,t] of cases){
  const r = prefilterThread(t as any, { recentBlocksMax: 6 } as any);
  console.log("===", k);
  console.log(JSON.stringify({score:r.score, action:r.action, gatePass:r.gatePass, trig:r.trigIds}, null, 0));
}
