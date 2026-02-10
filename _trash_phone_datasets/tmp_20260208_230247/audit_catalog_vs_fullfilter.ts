import { prefilterThread } from "../src/engine/prefilter/prefilter";
import { normalizeText } from "../src/engine/extract/normalize";
import { splitThread } from "../src/engine/extract/splitThread";
import { scoreThread } from "../src/engine/scoring/scoreThread";

type Def = {
    id: string;
    samples: string[];              // 최소 1개 이상
    pfMustAll: string[][];          // AND of (OR-list)
    engMustAll: string[][];         // AND of (OR-list)
};

function extractSenderOnlyText(thread: string): string {
    const t = String(thread || "").replace(/\r\n/g, "\n");
    const lines = t.split("\n");
    const sLines = lines
        .map((l) => {
            const m = l.match(/^\s*S\s*:\s*(.*)$/i);
            return m ? String(m[1] || "").trim() : "";
        })
        .filter(Boolean);
    return sLines.length > 0 ? sLines.join("\n") : t;
}

function uniq(xs: string[]) {
    return Array.from(new Set(xs.filter(Boolean)));
}

function pickSetOk(have: Set<string>, orList: string[]) {
    return orList.some((k) => have.has(k));
}

function checkAll(have: Set<string>, mustAll: string[][]) {
    const missing: string[][] = [];
    for (const group of mustAll) {
        if (!pickSetOk(have, group)) missing.push(group);
    }
    return { ok: missing.length === 0, missing };
}

// ---- 시나리오 카탈로그 “점검용 최소 샘플” ----
// pf_* 는 네 cover 스크립트에서 나오던 id 기준으로만 씀.
// 엔진 ruleId는 scoreThread.ts에서 보이던 것들(transfer/link/otp/remote/ctx_* 등)로 묶음.
const defs: Def[] = [
    {
        id: "prosecutor_police_impersonation",
        samples: [
            `S: 서울중앙지검 수사관입니다. 계좌가 사건에 연루돼 지급정지 예정입니다. 지금 바로 링크로 본인확인 진행하세요.`,
        ],
        pfMustAll: [
            ["pf_authority"],
            ["pf_threat", "pf_urgency", "pf_link_verbs", "pf_transfer", "pf_otp", "pf_remote", "pf_visit_place", "pf_cash_pickup"],
        ],
        engMustAll: [
            ["authority"],
            ["threat", "urgent", "link", "shortener", "transfer", "otp", "remote", "ctx_visit_place", "ctx_cash_pickup"],
        ],
    },

    {
        id: "safe_case",
        samples: [
            `S: 자금보호를 위해 안전계좌로 이체가 필요합니다. 지금 바로 이체해주세요.`,
        ],
        pfMustAll: [
            ["pf_transfer", "pf_authority"],
        ],
        engMustAll: [
            ["transfer", "safe_account", "ctx_payment_request", "ctx_transfer_phrase"],
        ],
    },

    {
        id: "bank_impersonation",
        samples: [
            `S: KB국민은행 보안팀입니다. OTP 6자리 인증번호 알려주셔야 차단됩니다.`,
        ],
        pfMustAll: [
            ["pf_authority"],
            ["pf_otp", "pf_otp_demand"],
        ],
        engMustAll: [
            ["authority"],
            ["otp", "call_otp", "ctx_otp_relay", "ctx_otp_proxy", "ctx_otp_finance"],
        ],
    },

    {
        id: "account_seizure",
        samples: [
            `S: 비정상 로그인 시도가 확인돼 계정이 잠겼습니다. 아래 링크로 인증 진행하세요.`,
        ],
        pfMustAll: [
            ["pf_account_verify", "pf_threat"],
            ["pf_link_verbs", "pf_otp", "pf_remote"],
        ],
        engMustAll: [
            ["account_verify", "txn_alert", "threat"],
            ["link", "shortener", "otp", "remote", "install_app", "apk", "url_download_ext"],
        ],
    },

    {
        id: "card_issue",
        samples: [
            `S: 카드 분실 신고 접수되었습니다. 재발급 신청은 링크에서 본인인증 해주세요.`,
        ],
        pfMustAll: [
            ["pf_authority"],
            ["pf_link_verbs", "pf_otp", "pf_pii"],
        ],
        engMustAll: [
            ["authority"],
            ["link", "shortener", "otp", "personalinfo", "pii_request"],
        ],
    },

    {
        id: "remote_app_install",
        samples: [
            `S: 보안점검을 위해 원격지원 앱 AnyDesk 설치 후 실행하세요.`,
        ],
        pfMustAll: [
            ["pf_remote"],
        ],
        engMustAll: [
            ["remote", "call_remote", "apk", "install_app", "url_download_ext", "ctx_install_mention"],
        ],
    },

    {
        id: "delivery_link",
        samples: [
            `S: 택배 주소 오류로 반송 예정입니다. 배송조회 링크 확인하세요.`,
        ],
        pfMustAll: [
            // 택배 전용 pf_id가 없다면, 링크/긴급/입력쪽 조합으로라도 잡히는지 확인
            ["pf_link_verbs", "pf_urgency"],
        ],
        engMustAll: [
            ["link", "shortener"],
        ],
    },

    {
        id: "government_subsidy",
        samples: [
            `S: 지원금 대상자입니다. 신청 링크에서 계좌 입력하세요.`,
        ],
        pfMustAll: [
            ["pf_benefit_hook", "pf_benefit_link_mention"],
            ["pf_link_verbs", "pf_transfer", "pf_pii"],
        ],
        engMustAll: [
            ["ctx_government_benefit"],
            ["link", "shortener", "transfer", "personalinfo"],
        ],
    },

    {
        id: "invoice_tax",
        samples: [
            `S: 지방세 미납 고지서입니다. 링크에서 납부하세요.`,
        ],
        pfMustAll: [
            ["pf_link_verbs", "pf_transfer"],
        ],
        engMustAll: [
            ["link", "shortener", "transfer"],
        ],
    },

    {
        id: "loan_scam",
        samples: [
            `S: 저금리 대출 승인. 보증금 30만원 입금하면 진행됩니다.`,
        ],
        pfMustAll: [
            ["pf_transfer"],
        ],
        engMustAll: [
            ["transfer", "ctx_payment_request", "ctx_transfer_phrase"],
        ],
    },

    {
        id: "cash_pickup",
        samples: [
            `S: 현금 300만원을 봉투에 넣어 로비로 보내주세요. 퀵이 수거합니다.`,
        ],
        pfMustAll: [
            ["pf_cash_pickup"],
        ],
        engMustAll: [
            ["ctx_cash_pickup"],
        ],
    },

    {
        id: "go_bank_atm",
        samples: [
            `S: 지금 ATM 가서 2번 눌러 인증 진행하세요.`,
        ],
        pfMustAll: [
            ["pf_visit_place"],
        ],
        engMustAll: [
            ["go_bank_atm", "ctx_visit_place"],
        ],
    },

    {
        id: "messenger_phishing",
        samples: [
            `S: 카톡 프로필 확인하고 링크 눌러 로그인해.`,
            `S: 오픈채팅으로 이동해서 안내드릴게요. 링크 확인하세요.`,
        ],
        pfMustAll: [
            ["pf_messenger_profile"],
            ["pf_link_verbs", "pf_account_verify"],
        ],
        engMustAll: [
            ["ctx_contact_move", "ctx_messenger_profile", "messenger_phishing"],
            ["link", "shortener", "account_verify"],
        ],
    },

    {
        id: "job_highpay_abroad",
        samples: [
            `S: 고수익 알바입니다. 오픈채팅으로 이동 후 면접장 주소 드려요. 등록비 입금 필요합니다.`,
        ],
        pfMustAll: [
            ["pf_job_hook"],
            ["pf_messenger_profile", "pf_visit_place", "pf_transfer", "pf_remote"],
        ],
        engMustAll: [
            ["ctx_job_hook"],
            ["ctx_contact_move", "ctx_visit_place", "transfer", "remote", "install_app"],
        ],
    },

    {
        id: "gifticon_market",
        samples: [
            `S: 기프티콘 매입합니다. 핀번호 캡처해서 보내고 수수료 입금해.`,
        ],
        pfMustAll: [
            ["pf_transfer", "pf_pii", "pf_link_verbs"],
        ],
        engMustAll: [
            ["transfer", "personalinfo", "link"],
        ],
    },

    {
        id: "romance_investment",
        samples: [
            `S: VIP 리딩방 초대합니다. 텔레그램으로 이동해서 가입 링크 확인 후 입금하면 수익 보장.`,
        ],
        pfMustAll: [
            ["pf_messenger_profile", "pf_transfer", "pf_link_verbs"],
        ],
        engMustAll: [
            ["ctx_contact_move", "transfer", "link", "shortener", "ctx_investment_link"],
        ],
    },

    {
        id: "gray_zone",
        samples: [
            `S: 비밀 채팅으로 이동하세요. 텔레그램에서 안내 후 입금하면 코드 드립니다.`,
        ],
        pfMustAll: [
            ["pf_messenger_profile"],
            ["pf_transfer"],
        ],
        engMustAll: [
            ["ctx_contact_move"],
            ["transfer"],
        ],
    },
];

function asSet(xs: string[]) {
    return new Set(xs.filter(Boolean));
}

async function main() {
    let fail = 0;

    for (const d of defs) {
        let oneOk = false;
        const details: string[] = [];

        for (const sample of d.samples) {
            const thread = sample.includes("\n") ? sample : `S: ${sample.replace(/^S:\s*/i, "")}`;
            const sText = extractSenderOnlyText(thread);

            const pf: any = prefilterThread(sText);
            const pfIds = uniq((pf?.signals ?? []).map((x: any) => String(x?.id ?? x?.ruleId ?? "").trim()));
            const pfSet = asSet(pfIds);

            const normThread = normalizeText(thread);
            const messages = splitThread(normThread);
            const scored: any = scoreThread(messages as any, undefined as any, undefined as any);

            const hitIds = uniq((scored?.hits ?? []).map((h: any) => String(h?.ruleId ?? "").trim()));
            const hitSet = asSet(hitIds);

            const pfChk = checkAll(pfSet, d.pfMustAll);
            const engChk = checkAll(hitSet, d.engMustAll);

            if (pfChk.ok && engChk.ok) {
                oneOk = true;
                break;
            }

            details.push(
                [
                    `  sample: ${thread.replace(/\n/g, " / ")}`,
                    `    pfIds: ${pfIds.join(", ")}`,
                    `    hitIds(top~): ${hitIds.slice(0, 30).join(", ")}${hitIds.length > 30 ? " ..." : ""}`,
                    `    PF missing: ${pfChk.missing.map((g) => `[${g.join("|")}]`).join(" ") || "-"}`,
                    `    ENG missing: ${engChk.missing.map((g) => `[${g.join("|")}]`).join(" ") || "-"}`,
                ].join("\n")
            );
        }

        if (!oneOk) {
            fail++;
            console.log(`FAIL: ${d.id}`);
            console.log(details.join("\n"));
        } else {
            console.log(`OK: ${d.id}`);
        }
    }

    console.log(`\nDONE defs=${defs.length} fail=${fail}`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
