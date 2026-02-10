import fs from "fs";
import path from "path";

type AnyRec = Record<string, any>;

function readJsonl(filePath: string): AnyRec[] {
    const text = fs.readFileSync(filePath, "utf8");
    const out: AnyRec[] = [];
    for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try {
            out.push(JSON.parse(s));
        } catch {
            // skip bad line
        }
    }
    return out;
}

function writeJsonl(filePath: string, rows: AnyRec[]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function basename(p: string) {
    return path.basename(p).replace(/\\/g, "/");
}

function normalizeSenderToken(thread: string): string {
    if (!thread) return thread;

    // 1) "[ 발신" -> "[발신", and trim inside brackets a bit
    let t = thread.replace(/\[\s*발신\s*/g, "[발신 ");

    // 2) normalize phone dashes/spaces only inside the [발신 ...] token
    t = t.replace(/\[발신\s+([^\]]+)\]/g, (_m, inner) => {
        let x = String(inner ?? "").trim();

        // keep 발신번호표시제한 as-is
        if (x.includes("발신번호표시제한")) return "[발신 발신번호표시제한]";

        // collapse whitespace around hyphens
        x = x.replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();

        return `[발신 ${x}]`;
    });

    return t;
}

function hasImpersonation(rec: AnyRec): boolean {
    const cat = String(rec.category ?? "").toLowerCase();
    const notes = Array.isArray(rec.notes) ? rec.notes.join(" ") : String(rec.notes ?? "");
    const th = String(rec.thread ?? rec.threadText ?? rec.input?.threadText ?? "");

    return (
        cat.includes("prosecutor") ||
        cat.includes("police") ||
        cat.includes("government") ||
        cat.includes("fine") ||
        cat.includes("tax") ||
        cat.includes("refund") ||
        notes.includes("imp_gov") ||
        /금감원|검찰|경찰|국세청|정부24|법원|수사|환급|과태료|미납/.test(th)
    );
}

function hasBankLike(rec: AnyRec): boolean {
    const cat = String(rec.category ?? "").toLowerCase();
    const th = String(rec.thread ?? rec.threadText ?? rec.input?.threadText ?? "");
    return cat.includes("bank") || cat.includes("loan") || cat.includes("card") || /은행|카드|대출/.test(th);
}

function hasFamilyLike(rec: AnyRec): boolean {
    const cat = String(rec.category ?? "").toLowerCase();
    const th = String(rec.thread ?? rec.threadText ?? rec.input?.threadText ?? "");
    return cat.includes("family") || /엄마|아빠|아들|딸|가족|지인/.test(th);
}

function hasBlackmailLike(rec: AnyRec): boolean {
    const cat = String(rec.category ?? "").toLowerCase();
    const th = String(rec.thread ?? rec.threadText ?? rec.input?.threadText ?? "");
    return cat.includes("blackmail") || /협박|유포|벌금|영상|성관계/.test(th);
}

function getRiskLabel(rec: AnyRec): "low" | "medium" | "high" | "" {
    const l = String(rec.label ?? "").toLowerCase();
    if (l === "low" || l === "medium" || l === "high") return l as any;
    const e = String(rec.expected?.riskLevel ?? "").toLowerCase();
    if (e === "low" || e === "medium" || e === "high") return e as any;
    return "";
}

function chooseSenderNumber(rec: AnyRec): string {
    const risk = getRiskLabel(rec);

    // blackmail-like: prefer hidden caller for high/medium
    if (hasBlackmailLike(rec) && (risk === "high" || risk === "medium")) return "발신번호표시제한";

    // ⚠️ KR에는 “안전한 예시 번호 대역”이 명확히 없어서,
    // 데모/공개 데이터셋에는 실번호가 될 수 없는(=전화번호 패턴을 일부러 깨뜨린) 값을 사용한다.
    const FAKE_MOBILE = "010-0000-101";    // 끝 3자리 => 일반 전화번호 정규식에 안 걸리게 설계
    const FAKE_VOIP = "070-0000-201";      // 끝 3자리 => 동일
    const FAKE_LANDLINE = "02-0000-200";   // 끝 3자리 => 동일
    const FAKE_GENERIC = "0000-0000";      // 아예 비정상 포맷(대표번호/국번 충돌 방지)

    // family: personal mobile makes sense even in low
    if (hasFamilyLike(rec)) return FAKE_MOBILE;

    // impersonation policy
    if (hasImpersonation(rec)) {
        if (risk === "low") return FAKE_LANDLINE; // “정상 안내”라도 실번호 충돌 방지
        return FAKE_VOIP;                         // 사칭은 개인/인터넷전화 느낌(비정상 포맷 유지)
    }

    // bank-like
    if (hasBankLike(rec)) {
        if (risk === "low") return FAKE_GENERIC; // 1588류는 실존 가능성이 있어 금지
        return FAKE_MOBILE;
    }

    // default
    if (risk === "low") return FAKE_LANDLINE;
    return FAKE_MOBILE;
}

/**
 * demo 산출물에서 실번호 가능성을 0에 가깝게 만들기 위한 스크럽:
 * - thread/메타/기타 string 필드에 들어있는 010-xxxx-xxxx, 1588-xxxx, 0XXXXXXXXXX 같은 phone-like 패턴을 전부 안전 placeholder로 치환
 * - placeholder는 일부러 “정규식에 안 걸리게” (끝 3자리) 또는 “비정상 포맷(0000-0000)” 사용
 */
const RE_PHONE_ANY =
    /(?:\+82[-\s]?)?(?:0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}\b|\b1[5-8]\d{2}[-\s]?\d{4}\b|\b0\d{9,10}\b|\b1[5-8]\d{6}\b/g;

function scrubPhoneLikeInText(s: string): string {
    if (!s) return s;

    return s.replace(RE_PHONE_ANY, (m) => {
        const x = String(m || "").trim();

        // already-safe placeholders
        if (x === "0000-0000") return x;
        if (/\b010-0000-101\b/.test(x)) return x;
        if (/\b070-0000-201\b/.test(x)) return x;
        if (/\b02-0000-200\b/.test(x)) return x;

        const compact = x.replace(/\s+/g, "");

        // 대표번호(15xx/16xx/18xx)는 실존 가능성이 높으니 완전 비정상으로
        if (/^1[5-8]\d{2}/.test(compact)) return "0000-0000";

        // 0xx/010/070/02 류는 끝자리를 3자리로 깨서 phone regex에 안 걸리게
        if (/^(?:\+82[-\s]?)?010/.test(compact)) return "010-0000-101";
        if (/^(?:\+82[-\s]?)?070/.test(compact)) return "070-0000-201";
        if (/^(?:\+82[-\s]?)?02/.test(compact)) return "02-0000-200";

        // 나머지는 비정상 placeholder
        return "0000-0000";
    });
}

function scrubPhoneLikeDeep(v: any): any {
    if (v === null || v === undefined) return v;

    if (typeof v === "string") return scrubPhoneLikeInText(v);

    if (Array.isArray(v)) return v.map((x) => scrubPhoneLikeDeep(x));

    if (typeof v === "object") {
        const out: AnyRec = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = scrubPhoneLikeDeep(val);
        }
        return out;
    }

    return v;
}

function injectOrReplaceSender(thread: string, sender: string): string {
    if (!thread) return thread;

    // normalize existing token formatting first
    let t = normalizeSenderToken(thread);

    // replace existing [발신 ...]
    if (/\[발신\s+[^\]]+\]/.test(t)) {
        return t.replace(/\[발신\s+[^\]]+\]/, sender === "발신번호표시제한" ? "[발신 발신번호표시제한]" : `[발신 ${sender}]`);
    }

    // otherwise inject into first S: line; if none, prefix as a new S: line
    const token = sender === "발신번호표시제한" ? "[발신 발신번호표시제한] " : `[발신 ${sender}] `;
    if (/^S:\s*/m.test(t)) {
        return t.replace(/^S:\s*/m, `S: ${token}`);
    }
    return `S: ${token}${t}`;
}

function deriveDemoTags(inputFile: string): string[] {
    const f = inputFile.toLowerCase();
    const tags: string[] = [];
    if (f.includes("mutated") || f.includes("mlm")) tags.push("mlm");
    if (f.includes("typo") || f.includes("homoglyph")) tags.push("typo");
    if (f.includes("urlfixed")) tags.push("urlfixed");
    return tags;
}

function getThreadAny(r: AnyRec): string {
    const a = r ?? {};
    const v =
        a.thread ??
        a.threadText ??
        a.input?.threadText ??
        a.meta?.threadText ??
        a.scenario?.threadText ??
        a.text ??
        "";
    return String(v ?? "");
}

function setThreadEverywhere(r: AnyRec, patchedThread: string): AnyRec {
    const a = r ?? {};
    const inputObj = a.input;
    const nextInput =
        inputObj && typeof inputObj === "object" && !Array.isArray(inputObj)
            ? { ...inputObj, threadText: patchedThread }
            : inputObj;

    return {
        ...a,
        thread: patchedThread,
        threadText: patchedThread,
        input: nextInput,
    };
}

// ---- CLI ----
const args = process.argv.slice(2);
const inFiles: string[] = [];
let outDir = "public/datasets/ko_scam";

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--in") inFiles.push(args[++i]);
    else if (a === "--out") outDir = args[++i];
}

if (!inFiles.length) {
    console.error("Usage: npx tsx tools/datasets/buildDemoSets.ts --out <dir> --in <file1> --in <file2> ...");
    process.exit(1);
}

const lowOut: AnyRec[] = [];
const nonlowOut: AnyRec[] = [];
const seen = new Set<string>();

for (const f of inFiles) {
    const rows = readJsonl(f);
    const tagsFromFile = deriveDemoTags(f);

    for (const r of rows) {
        const id = String(r.id ?? "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);

        const risk = getRiskLabel(r);
        const sender = chooseSenderNumber(r);

        const baseThread = getThreadAny(r);
        const patchedThread0 = injectOrReplaceSender(baseThread, sender);

        // ✅ thread 안에 남아있는 phone-like(실번호 가능) 패턴을 전부 안전 placeholder로 스크럽
        const patchedThread = scrubPhoneLikeInText(patchedThread0);

        const baseNext = setThreadEverywhere(r, patchedThread);

        const next0: AnyRec = {
            ...baseNext,
            // demo header용(있으면 쓰게)
            fromNumber: sender === "발신번호표시제한" ? "" : sender,
            meta: {
                ...(baseNext.meta ?? {}),
                fromNumber: sender === "발신번호표시제한" ? "" : sender,
                demo: {
                    source_file: basename(f),
                    tags: tagsFromFile,
                    sender_policy: sender,
                },
            },
            input:
                baseNext.input && typeof baseNext.input === "object" && !Array.isArray(baseNext.input)
                    ? { ...baseNext.input, fromNumber: sender === "발신번호표시제한" ? "" : sender }
                    : baseNext.input,
        };

        // ✅ meta/notes/기타 문자열 필드에 숨은 번호까지 전부 스크럽(데모 산출물에서 phone-like 0 목표)
        const next: AnyRec = scrubPhoneLikeDeep(next0);

        if (risk === "low") lowOut.push(next);
        else nonlowOut.push(next);
    }
}

writeJsonl(path.join(outDir, "demo_low__core.jsonl"), lowOut);
writeJsonl(path.join(outDir, "demo_nonlow__core_plus_mlm.jsonl"), nonlowOut);

console.log(`Wrote low=${lowOut.length}, nonlow=${nonlowOut.length} -> ${outDir}`);
