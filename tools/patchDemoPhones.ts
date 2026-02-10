// tools/patchDemoPhones.ts
import fs from "fs";
import path from "path";
import readline from "readline";
import crypto from "crypto";

type AnyObj = Record<string, any>;

function u32FromId(id: string): number {
    const h = crypto.createHash("sha1").update(String(id || "")).digest();
    // take first 4 bytes
    return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

function pick<T>(arr: T[], seed: number): T {
    const n = arr.length;
    if (!n) throw new Error("empty pool");
    const idx = Math.max(0, Math.min(n - 1, seed % n));
    return arr[idx];
}

function digitsOnly(s: string): string {
    return String(s || "").replace(/\D/g, "");
}

function fmt010(d: string) {
    // 010XXXXXXXX (11)
    if (d.length !== 11) return d;
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}
function fmt070(d: string) {
    // 070XXXXYYYY (11) or 070XXXYYYY (10) - we enforce 11 digits
    if (d.length !== 11) return d;
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}
function fmt02(d: string) {
    // 02XXXXXXXX (10) -> 02-XXXX-XXXX
    if (!d.startsWith("02") || d.length !== 10) return d;
    return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
}
function fmt1588(d: string) {
    // 1588XXXX (8)
    if (!/^1[5-8]\d{6}$/.test(d)) return d;
    return `${d.slice(0, 4)}-${d.slice(4)}`;
}

const POOL_PERSONAL_010 = [
    "01000000001",
    "01000000002",
    "01000000003",
    "01000001234",
    "01000005678",
    "01012340000",
    "01056780000",
];

const POOL_VOIP_070 = [
    "07000000001",
    "07000000002",
    "07000000201",
    "07000000999",
    "07012340000",
    "07056780000",
];

const POOL_OFFICIAL_02 = [
    "0200000000",
    "0200000001",
    "0211111111",
    "0222222222",
    "0233333333",
];

const POOL_BANK_1588 = [
    "15880000",
    "15881111",
    "15881234",
    "15889999",
];

function detectBank(text: string) {
    return /(은행|계좌|이체|송금|입금|대출|카드|금융|KB|국민|신한|우리|하나|농협|카카오뱅크|토스뱅크|토스|증권)/i.test(text);
}
function detectGov(text: string) {
    return /(검찰|경찰|수사|검찰청|경찰서|금감원|금융감독|국세청|법원|민원|행정|사건|압류|동결|체포|영장|벌금|과태료)/i.test(text);
}
function detectTelecom(text: string) {
    return /(통신|KT|SKT|LGU\+|유플러스|요금|정지|미납|휴대폰|유심|USIM)/i.test(text);
}
function detectChatOrSms(text: string) {
    return /(문자|메시지|SMS|카톡|카카오톡|텔레그램|DM)/i.test(text);
}
function detectCall(text: string) {
    return /(전화|통화|콜|ARS|상담|연결|누르고\s*\d|누르시고\s*\d)/i.test(text);
}

function inferIsBenign(obj: AnyObj, text: string): boolean {
    // 1) expected 기반 (있으면 우선)
    const exp = obj?.expected;
    if (exp) {
        if (exp.should_trigger === false) return true;
        const tr = Array.isArray(exp.triggers) ? exp.triggers : [];
        if (tr.length === 0 && (String(exp.riskLevel || "").toLowerCase() === "low" || exp.riskLevel === "low")) {
            return true;
        }
    }

    // 2) 휴리스틱: 명백한 악성 앵커가 없으면 benign 취급 (데모용)
    const malAnchors =
        /(인증번호|OTP|원격|팀뷰어|애니데스크|설치|apk|앱 설치|링크|url|http|송금|이체|입금|계좌|대출|협박|압류|동결|수사|벌금|과태료)/i;
    return !malAnchors.test(text);
}

function decidePhone(obj: AnyObj, text: string): { phone: string; benign: boolean } {
    const benign = inferIsBenign(obj, text);

    // “정상은 기관유형에 따라 02/1588”
    if (benign) {
        if (detectBank(text)) {
            const d = pick(POOL_BANK_1588, u32FromId(obj.id ?? obj.caseId ?? text) >>> 0);
            return { phone: fmt1588(d), benign: true };
        }
        // 기관/공식/통신 포함은 일단 02로
        const d = pick(POOL_OFFICIAL_02, u32FromId(obj.id ?? obj.caseId ?? text) >>> 0);
        return { phone: fmt02(d), benign: true };
    }

    // “위험/사칭은 무조건 비정상 번호” → 010/070 강제
    // 기관사칭(정부/은행/통신 등 포함) = 개인/VOIP 번호로
    const seed = u32FromId(obj.id ?? obj.caseId ?? text) >>> 0;
    const prefer010 = detectChatOrSms(text);
    const prefer070 = detectCall(text);

    // call 느낌이면 070 우선, 아니면 010
    if (prefer070 && !prefer010) {
        const d = pick(POOL_VOIP_070, seed);
        return { phone: fmt070(d), benign: false };
    }
    const d = pick(POOL_PERSONAL_010, seed);
    return { phone: fmt010(d), benign: false };
}

function patchSenderInText(thread: string, phone: string): string {
    let t = String(thread || "");

    // 1) [발신 ...] 있으면 교체
    const reSender = /\[\s*발\s*신[^\]]*\]/g;
    if (reSender.test(t)) {
        t = t.replace(reSender, `[발신 ${phone}]`);
        return t;
    }

    // 2) 첫 S: 라인에 삽입 (없으면 문서 맨 앞)
    const lines = t.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*S\s*:\s*(.*)$/i);
        if (m) {
            const body = m[1] ?? "";
            lines[i] = `S: [발신 ${phone}] ${body}`.trimEnd();
            return lines.join("\n");
        }
    }

    // 3) S:가 없으면 맨 앞에 [발신]만 붙임
    return `[발신 ${phone}] ` + t;
}

function patchObject(obj: AnyObj): AnyObj {
    const clone: AnyObj = obj && typeof obj === "object" ? { ...obj } : {};
    const textFields = ["rawThread", "thread", "text", "threadText", "raw"];

    // 텍스트 후보(휴리스틱)
    const anyText =
        textFields.map((k) => (typeof clone[k] === "string" ? String(clone[k]) : "")).find((s) => s.trim().length > 0) ||
        "";

    const { phone, benign } = decidePhone(clone, anyText);

    // meta에도 넣어두면 UI에서 쓰기 쉬움
    const meta = clone.meta && typeof clone.meta === "object" ? { ...clone.meta } : {};
    meta.fromNumber = phone;
    meta.isSavedContact = !!benign;
    clone.meta = meta;
    clone.fromNumber = phone;

    // 가능한 텍스트 필드들은 모두 패치 (존재하는 것만)
    for (const k of textFields) {
        if (typeof clone[k] === "string" && String(clone[k]).trim()) {
            clone[k] = patchSenderInText(String(clone[k]), phone);
        }
    }

    return clone;
}

async function main() {
    const argv = process.argv.slice(2);
    const get = (flag: string) => {
        const i = argv.indexOf(flag);
        if (i >= 0) return argv[i + 1];
        return null;
    };

    const inPath = get("--in");
    const outPath = get("--out");
    if (!inPath || !outPath) {
        console.error("Usage: npx tsx tools/patchDemoPhones.ts --in <in.jsonl> --out <out.jsonl>");
        process.exit(2);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const rl = readline.createInterface({
        input: fs.createReadStream(inPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    const out = fs.createWriteStream(outPath, { encoding: "utf8" });

    let n = 0;
    for await (const line of rl) {
        const s = String(line || "");
        if (!s.trim()) continue;

        let obj: AnyObj;
        try {
            obj = JSON.parse(s);
        } catch {
            // json 파싱 실패 라인은 그대로 유지
            out.write(s + "\n");
            continue;
        }

        const patched = patchObject(obj);
        out.write(JSON.stringify(patched) + "\n");

        n++;
        if (n % 2000 === 0) {
            // eslint-disable-next-line no-console
            console.error(`patched ${n} lines...`);
        }
    }

    out.end();
    console.error(`done. patched lines=${n}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
