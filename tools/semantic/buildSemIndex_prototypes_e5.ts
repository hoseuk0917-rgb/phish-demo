// tools/semantic/buildSemIndex_prototypes_e5.ts
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "@xenova/transformers";

const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
const DEFAULT_OUT = "./public/semindex_ko_e5_small_v1.json";

type Proto = {
  id: string;
  category: string;
  expectedRisk?: string;
  textHint?: string;
  text: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  return undefined;
}

async function main() {
  const model = arg("--model") ?? DEFAULT_MODEL;
  const outPath = arg("--out") ?? DEFAULT_OUT;

  const protos: Proto[] = [
    { id: "proto_otp_relay", category: "OTP/인증코드", expectedRisk: "high", textHint: "OTP 전달 요구", text: "인증번호 6자리 왔죠? 지금 바로 불러주세요. 대신 입력해 드릴게요." },
    { id: "proto_remote_app", category: "원격/앱설치", expectedRisk: "high", textHint: "원격앱 설치", text: "안전조치 위해 원격지원 앱 설치 후 화면 공유해주세요." },
    { id: "proto_link_account", category: "링크/계정", expectedRisk: "medium", textHint: "링크 로그인", text: "계정 보안 확인이 필요합니다. 아래 링크에서 로그인 후 인증 진행하세요." },
    { id: "proto_delivery_fee", category: "택배/결제", expectedRisk: "medium", textHint: "수수료 결제", text: "택배가 보류되었습니다. 수수료 결제 후 배송 재개됩니다. 링크에서 결제해주세요." },
    { id: "proto_gov_benefit", category: "정부지원", expectedRisk: "medium", textHint: "지원금/환급", text: "지원금 대상입니다. 신청 확인을 위해 본인인증을 진행해주세요." },
    { id: "proto_job_offer", category: "구인/알바", expectedRisk: "medium", textHint: "구인/수익", text: "간단한 작업으로 수익 가능합니다. 먼저 계정 등록과 본인확인 진행해주세요." },
    { id: "proto_card_gift", category: "상품권", expectedRisk: "high", textHint: "핀번호 요구", text: "상품권 핀번호를 보내주시면 처리해 드립니다. 지금 바로 구매 후 번호 전달해주세요." },
    { id: "proto_crypto_invest", category: "코인/투자", expectedRisk: "high", textHint: "코인 송금", text: "지정 지갑으로 코인을 송금하면 바로 수익 시작됩니다." },
    { id: "proto_bank_transfer", category: "송금/계좌", expectedRisk: "high", textHint: "안전계좌 이체", text: "안전계좌로 이체해야 보호됩니다. 지금 ATM에서 이체 진행하세요." },
    { id: "proto_threat_police", category: "협박/권위", expectedRisk: "high", textHint: "기관 사칭 압박", text: "당신 명의 사건입니다. 즉시 협조하지 않으면 체포영장 발부됩니다." },
  ];

  const extractor = await pipeline("feature-extraction", model);

  const items: any[] = [];
  for (const p of protos) {
    const inp = `query: ${p.text}`;
    const emb: any = await (extractor as any)(inp, { pooling: "mean", normalize: true });

    let vec: number[] | null = null;
    if (Array.isArray(emb)) vec = emb as any;
    else if (emb instanceof Float32Array) vec = Array.from(emb);
    else if (emb?.data instanceof Float32Array) vec = Array.from(emb.data);
    else if (typeof emb?.tolist === "function") {
      const t = emb.tolist();
      if (Array.isArray(t) && Array.isArray(t[0])) vec = (t[0] as number[]).slice();
      else if (Array.isArray(t)) vec = (t as number[]).slice();
    }

    if (!vec || vec.length === 0) throw new Error(`embed failed for ${p.id}`);

    items.push({
      id: p.id,
      category: p.category,
      expectedRisk: p.expectedRisk,
      textHint: p.textHint,
      vec,
    });
  }

  const dim = items[0]?.vec?.length ?? 0;

  const out = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: "prototypes",
    lang: "ko",
    model,
    dim,
    items,
  };

  const outAbs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(out), "utf8");

  console.log(`OK semindex written: ${outPath}`);
  console.log(`items=${items.length} dim=${dim} model=${model}`);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exitCode = 1;
});
