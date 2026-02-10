// tools/analysis/buildNormalized.ts
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { stripHtml, normalizeText } from "./normalizeText";
import type { NormalizedDoc, AttachmentTextInfo } from "./types";
import iconv from "iconv-lite";

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

type AnyObj = Record<string, any>;

// ✅ 타입 안전장치: types.ts에 attachment_texts가 아직 없더라도 컴파일되게
type NormalizedDocOut = NormalizedDoc & { attachment_texts?: AttachmentTextInfo[] };

function parseArgs(argv: string[]) {
    const out: AnyObj = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const k = a.slice(2);
        const v = argv[i + 1];
        if (!v || v.startsWith("--")) out[k] = true;
        else {
            out[k] = v;
            i++;
        }
    }
    return out;
}

function asBool(v: any, def: boolean) {
    if (v === undefined) return def;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    return true;
}

function clampText(s: string, maxChars: number) {
    const t = String(s ?? "");
    if (maxChars <= 0) return t;
    return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function sanitizeFileName(name: string) {
    return String(name ?? "")
        .replace(/[\\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
}

function posixRel(p: string) {
    return path.relative(process.cwd(), p).replace(/\\/g, "/");
}

function normalizePstDir(pstSn: string) {
    const n = Number(String(pstSn || "").trim());
    if (!Number.isFinite(n) || n <= 0) return String(pstSn || "").trim();
    return String(n); // "002" -> "2"
}

function listTxtFiles(dirAbs: string) {
    const out: string[] = [];
    try {
        const ents = fs.readdirSync(dirAbs, { withFileTypes: true });
        for (const e of ents) {
            if (!e.isFile()) continue;
            if (!e.name.toLowerCase().endsWith(".txt")) continue;
            out.push(e.name);
        }
    } catch {
        // ignore
    }
    return out;
}

function buildExistingTxtMap(dirAbsList: string[]) {
    // key: rawBaseName (e.g. FILE_xxx.hwp) -> rel txt path (e.g. .../FILE_xxx.hwp.txt)
    const map = new Map<string, string>();

    for (const dirAbs of dirAbsList) {
        if (!dirAbs) continue;
        if (!fs.existsSync(dirAbs)) continue;
        if (!fs.statSync(dirAbs).isDirectory()) continue;

        for (const name of listTxtFiles(dirAbs)) {
            const rawBase = name.slice(0, -4); // remove ".txt"
            const txtAbs = path.join(dirAbs, name);
            // 이미 있으면 먼저 들어온(우선순위 높은) 걸 유지
            if (!map.has(rawBase)) map.set(rawBase, posixRel(txtAbs));
        }
    }

    return map;
}

function hydrateAttachmentTextsFromExistingTxts(
    source: string,
    pstSnRaw: string,
    attachments: Array<{ name: string; saved_as: string; url: string }>,
    attachment_texts: AttachmentTextInfo[] | undefined,
    attachOutDirAbs: string,
    debug = false
) {
    const pstDir = normalizePstDir(pstSnRaw);

    const dirNorm = path.join(attachOutDirAbs, source, `pstSn_${pstDir}`);
    const dirRaw = path.join(attachOutDirAbs, source, `pstSn_${pstSnRaw}`);

    const dirs: string[] = [];
    // ✅ normalized dir 우선(pstSn_2 같은 쪽)
    if (dirNorm && !dirs.includes(dirNorm)) dirs.push(dirNorm);
    if (dirRaw && !dirs.includes(dirRaw)) dirs.push(dirRaw);

    const txtMap = buildExistingTxtMap(dirs);
    if (txtMap.size === 0) return { attachment_texts, attachments_text_dir: "" };

    const out = Array.isArray(attachment_texts) ? attachment_texts : [];
    const bySaved = new Map<string, AttachmentTextInfo>();
    for (const t of out) {
        if (t?.saved_as) bySaved.set(t.saved_as, t);
    }

    let hydrated = 0;

    for (const a of attachments) {
        if (!a?.saved_as) continue;

        const rawBase = path.basename(String(a.saved_as)); // FILE_...hwp
        const txtRel = txtMap.get(rawBase);
        if (!txtRel) continue;

        const hit = bySaved.get(a.saved_as);
        if (hit) {
            if (!hit.text_path) {
                hit.text_path = txtRel;
                hydrated++;
            }
            // ✅ txt가 있으면 기존 note 제거
            if (hit.note && /^(skip_too_large|unsupported_ext|missing_dep)/.test(hit.note)) {
                delete hit.note;
            }
            if (!hit.chars) {
                try {
                    const abs = path.resolve(process.cwd(), txtRel);
                    const s = fs.readFileSync(abs, "utf8");
                    hit.chars = s.length;
                } catch {
                    // ignore
                }
            }
        } else {
            const info: AttachmentTextInfo = {
                name: a.name || rawBase,
                saved_as: a.saved_as,
                text_path: txtRel,
            };
            try {
                const abs = path.resolve(process.cwd(), txtRel);
                const s = fs.readFileSync(abs, "utf8");
                info.chars = s.length;
            } catch {
                // ignore
            }
            out.push(info);
            hydrated++;
        }
    }

    // raw_paths.attachments_text_dir는 “존재하는 dir” 중 txt가 더 많은 쪽을 기록
    const cNorm = listTxtFiles(dirNorm).length;
    const cRaw = listTxtFiles(dirRaw).length;
    const chosenAbs =
        cNorm >= cRaw && fs.existsSync(dirNorm) ? dirNorm : fs.existsSync(dirRaw) ? dirRaw : "";

    const chosenRel = chosenAbs ? posixRel(chosenAbs) : "";

    if (debug && hydrated > 0) {
        console.log(`[ATT_TEXT_HYDRATE] ${source}/pstSn_${pstSnRaw} +${hydrated} chosen=${chosenRel || "-"}`);
    }

    return { attachment_texts: out, attachments_text_dir: chosenRel };
}

// --- attachments filter (form/template docs) ---
const RE_FORM_ATTACH =
    /(이의신청서|신청서|서식|양식|작성(?:예시|방법)|제출서류|위임장|동의서|확인서)/u;
const RE_KEEP_ATTACH =
    /(사례|수법|피해|주의|경고|신종|악성|대응|보이스피싱|스미싱|사기)/u;

// ✅ txt도 포함
const RE_ATTACH_EXT = /\.(pdf|hwp|hwpx|doc|docx|ppt|pptx|xls|xlsx|zip|txt|md|csv)$/i;

function shouldSkipAttachmentName(fileName: string) {
    const name = String(fileName ?? "").trim();
    if (!name) return false;
    if (!RE_ATTACH_EXT.test(name)) return true; // 비문서/기타 확장자는 제외
    if (RE_KEEP_ATTACH.test(name)) return false; // keep overrides skip
    return RE_FORM_ATTACH.test(name);
}

function walk(dir: string, acc: string[]) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);

        // ✅ raw attachments 트리는 스캔 자체를 건너뜀
        if (ent.isDirectory() && ent.name.toLowerCase() === "attachments") continue;

        if (ent.isDirectory()) walk(p, acc);
        else acc.push(p);
    }
}

function inferSourcePst(filePath: string) {
    const base = path.basename(filePath);
    const norm = filePath.replace(/\\/g, "/");
    const parent = path.basename(path.dirname(filePath));

    // 1) 기본: 파일명에 source가 들어있는 케이스
    const m1 = base.match(/([a-z0-9_]+).*pstSn[_-]?(\d+)/i);
    if (m1) {
        let source = String(m1[1] ?? "");
        const pstSn = String(m1[2] ?? "");

        // 파일명 prefix가 detail/list 같은 "제너릭"이면 폴더에서 source 재추론
        const generic = new Set([
            "detail",
            "detail_",
            "list",
            "list_",
            "page",
            "pages",
            "board",
            "boardlist",
            "boarddetail",
        ]);

        if (generic.has(source.toLowerCase())) {
            const parts = norm.split("/").filter(Boolean);
            const idx = parts.lastIndexOf("pages");
            if (idx >= 0 && parts[idx + 1]) {
                source = String(parts[idx + 1]);
            } else if (parent) {
                source = parent;
            }
        }

        source = source.trim();
        if (!source) return null;
        return { source, pstSn };
    }

    // 2) fallback: 파일명에 pstSn만 있는 케이스
    const m2 = base.match(/pstSn[_-]?(\d+)/i);
    if (m2 && parent) return { source: parent, pstSn: String(m2[1] ?? "") };

    return null;
}

function inferTitle(html: string, text: string) {
    const mTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (mTitle) return normalizeText(stripHtml(mTitle[1])).slice(0, 200);

    const firstLine = text
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s.length > 0);
    return firstLine ? firstLine.slice(0, 200) : "";
}

function inferDate(text: string) {
    const m = text.match(/\b(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/);
    if (!m) return "";
    const y = m[1];
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
}

function sniffDeclaredCharset(buf: Buffer) {
    const head = buf.slice(0, 4096).toString("latin1");

    const m1 = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-]+)\s*["']?/i);
    if (m1?.[1]) return m1[1].toLowerCase();

    const m2 = head.match(
        /content-type[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([A-Za-z0-9_\-]+)[^"']*["']/i
    );
    if (m2?.[1]) return m2[1].toLowerCase();

    const m3 = head.match(/\bcharset\s*=\s*([A-Za-z0-9_\-]+)\b/i);
    if (m3?.[1]) return m3[1].toLowerCase();

    return "";
}

function countHangul(s: string) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (
            (c >= 0xac00 && c <= 0xd7a3) || // 가~힣
            (c >= 0x3130 && c <= 0x318f) || // 호환 자모
            (c >= 0x1100 && c <= 0x11ff) // 자모
        ) {
            n++;
        }
    }
    return n;
}

function countReplacement(s: string) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) n++;
    return n;
}

function countCjkLike(s: string) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const cp = s.codePointAt(i)!;
        if (cp > 0xffff) i++;

        if (
            (cp >= 0x4e00 && cp <= 0x9fff) ||
            (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0x2f800 && cp <= 0x2fa1f)
        ) {
            n++;
        }
    }
    return n;
}

function countChar(s: string, ch: string) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
    return n;
}

function scoreKoreanText(s: string) {
    const total = Math.max(1, s.length);
    const hangul = countHangul(s);
    const rep = countReplacement(s);
    const cjk = countCjkLike(s);
    const q = countChar(s, "?");

    const rHangul = hangul / total;
    const rCjk = cjk / total;

    const score =
        hangul * 20 +
        rHangul * 2200 +
        Math.min(total, 3000) * 0.02 -
        cjk * 45 -
        rCjk * 3200 -
        rep * 35 -
        Math.max(0, q - 8) * 18;

    return score;
}

function decodeUtf8(buf: Buffer, fatal: boolean) {
    try {
        const td = new TextDecoder("utf-8", { fatal });
        return { ok: true, text: td.decode(buf) };
    } catch {
        return { ok: false, text: "" };
    }
}

function maybeRepairMojibakeCp949ToUtf8(s: string) {
    const tries: string[] = [];

    const pushDecoded = (b: Buffer) => {
        const strict = decodeUtf8(b, true);
        if (strict.ok && strict.text) tries.push(strict.text);

        const loose = decodeUtf8(b, false);
        if (loose.ok && loose.text) tries.push(loose.text);
    };

    const tryOnce = (input: string) => {
        try {
            const b = iconv.encode(input, "cp949");
            pushDecoded(b);
        } catch {
            // ignore
        }
    };

    tryOnce(s);

    try {
        const nk = s.normalize("NFKC");
        if (nk && nk !== s) tryOnce(nk);
    } catch {
        // ignore
    }

    let best = s;
    let bestScore = scoreKoreanText(s);

    for (const t of tries) {
        const sc = scoreKoreanText(t);
        if (sc > bestScore + 10) {
            best = t;
            bestScore = sc;
        }
    }

    return best;
}

function decodeHtmlSmart(buf: Buffer, debug = false, ctx = "") {
    const declared = sniffDeclaredCharset(buf);

    const norm = (cs: string) =>
        cs
            .replace(/_/g, "-")
            .replace(/^utf8$/, "utf-8")
            .replace(/^euckr$/, "euc-kr")
            .replace(/^ksc5601$/, "euc-kr")
            .replace(/^ks-c-5601-1987$/, "euc-kr")
            .replace(/^ms949$/, "cp949")
            .replace(/^windows-949$/, "cp949");

    const d = norm(declared);

    const utf8Strict = decodeUtf8(buf, true);
    const utf8Raw = utf8Strict.ok ? utf8Strict.text : buf.toString("utf8");
    const cp949Raw = iconv.decode(buf, "cp949");
    const euckrRaw = iconv.decode(buf, "euc-kr");

    const utf8Fixed = maybeRepairMojibakeCp949ToUtf8(utf8Raw);
    const cp949Fixed = maybeRepairMojibakeCp949ToUtf8(cp949Raw);
    const euckrFixed = maybeRepairMojibakeCp949ToUtf8(euckrRaw);

    const bonusFor = (label: string) => {
        if (!d) return 0;
        if (d === "utf-8" && (label === "utf8" || label === "utf8_fixed")) return 25;
        if (d === "cp949" && (label === "cp949" || label === "cp949_fixed")) return 25;
        if (d === "euc-kr" && (label === "euc-kr" || label === "euc-kr_fixed")) return 25;
        return 0;
    };

    const candidates: Array<{ label: string; text: string }> = [
        { label: "utf8", text: utf8Raw },
        { label: "utf8_fixed", text: utf8Fixed },
        { label: "cp949", text: cp949Raw },
        { label: "cp949_fixed", text: cp949Fixed },
        { label: "euc-kr", text: euckrRaw },
        { label: "euc-kr_fixed", text: euckrFixed },
    ];

    let best = candidates[0]!;
    let bestScore = -Infinity;

    for (const c of candidates) {
        const sc = scoreKoreanText(c.text) + bonusFor(c.label);
        if (sc > bestScore) {
            bestScore = sc;
            best = c;
        }
    }

    const finalScore = scoreKoreanText(best.text);
    const repairedFinal = maybeRepairMojibakeCp949ToUtf8(best.text);
    const repairedScore = scoreKoreanText(repairedFinal);

    let out = best.text;
    let chosen = best.label;

    if (repairedScore > finalScore + 10) {
        out = repairedFinal;
        chosen = best.label + "+final_repair";
    }

    if (debug && (chosen.includes("fixed") || chosen.includes("repair"))) {
        console.log(`[DECODE_FIX] ${ctx} declared=${declared || "-"} chose=${chosen}`);
    }

    return out || utf8Raw;
}

// ✅ Readability로 “본문” 우선 추출
function extractReadable(html: string, fallbackText: string, debug = false, ctx = "") {
    try {
        const dom = new JSDOM(html, { url: "https://example.local/" });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        const title = article?.title ? normalizeText(article.title).slice(0, 200) : "";
        const text = article?.textContent ? normalizeText(article.textContent) : "";
        if (text && text.length >= Math.min(200, Math.max(50, fallbackText.length * 0.2))) {
            return { title, text };
        }
    } catch (e) {
        if (debug) console.log("[READABILITY_FAIL]", ctx, String(e));
    }
    return { title: "", text: fallbackText };
}

function listAttachments(rawRoot: string, source: string, pstSn: string, debug = false) {
    const out: Array<{ name: string; saved_as: string; url: string }> = [];

    // crawler 규칙: corpus/raw/attachments/<source>/pstSn_<pstSn>/...
    const attDir = path.join(rawRoot, "attachments", source, `pstSn_${pstSn}`);
    if (!fs.existsSync(attDir)) return out;

    const ents = fs.readdirSync(attDir, { withFileTypes: true });
    for (const e of ents) {
        if (!e.isFile()) continue;

        const file = e.name;
        const skip = shouldSkipAttachmentName(file);
        const abs = path.join(attDir, file);

        if (skip) {
            if (debug) console.log("[SKIP_FORM_ATTACH_NAME]", abs);
            continue;
        }

        // display name: FILE_xxx_4_이의신청서.hwpx -> 이의신청서.hwpx
        let display = file;
        const m = file.match(/^FILE_[A-Za-z0-9_]+_\d+_(.+)$/i);
        if (m && m[1]) display = m[1];

        out.push({
            name: display,
            saved_as: posixRel(abs),
            url: "",
        });
    }

    return out;
}

async function tryImportAny(name: string): Promise<any | null> {
    try {
        const m = await import(name);
        return (m as any)?.default ?? m;
    } catch {
        return null;
    }
}

async function extractAttachmentText(absPath: string, maxChars: number) {
    const ext = path.extname(absPath).toLowerCase();
    const buf = fs.readFileSync(absPath);

    if (ext === ".txt" || ext === ".md" || ext === ".csv") {
        const s = buf.toString("utf8");
        return clampText(normalizeText(s), maxChars);
    }

    if (ext === ".html" || ext === ".htm") {
        const html = buf.toString("utf8");
        const plain = normalizeText(stripHtml(html));
        const main = extractReadable(html, plain);
        return clampText(main.text, maxChars);
    }

    if (ext === ".pdf") {
        const pdfParse = await tryImportAny("pdf-parse");
        if (!pdfParse) return { __note: "missing_dep: pdf-parse" } as any;
        const data = await pdfParse(buf);
        const text = data?.text ? normalizeText(String(data.text)) : "";
        return clampText(text, maxChars);
    }

    if (ext === ".docx") {
        const mammoth = await tryImportAny("mammoth");
        if (!mammoth) return { __note: "missing_dep: mammoth" } as any;
        const r = await mammoth.extractRawText({ buffer: buf });
        const text = r?.value ? normalizeText(String(r.value)) : "";
        return clampText(text, maxChars);
    }

    if (ext === ".hwpx") {
        const AdmZip = await tryImportAny("adm-zip");
        if (!AdmZip) return { __note: "missing_dep: adm-zip" } as any;

        const zip = new AdmZip(absPath);
        const entries = zip.getEntries?.() ?? [];
        const xmls: string[] = [];

        for (const e of entries) {
            const name = String(e.entryName ?? "");
            if (!name.toLowerCase().endsWith(".xml")) continue;

            const lower = name.toLowerCase();
            const prefer =
                lower.includes("contents/section") ||
                lower.includes("word/document") ||
                lower.includes("content.hpf");

            if (!prefer) continue;

            try {
                const s = e.getData().toString("utf8");
                xmls.push(s);
            } catch {
                // ignore
            }
        }

        if (xmls.length === 0) {
            for (const e of entries) {
                const name = String(e.entryName ?? "");
                if (!name.toLowerCase().endsWith(".xml")) continue;
                try {
                    const s = e.getData().toString("utf8");
                    xmls.push(s);
                } catch {
                    // ignore
                }
            }
        }

        const joined = xmls.join("\n");
        const text = normalizeText(stripHtml(joined));
        return clampText(text, maxChars);
    }

    return { __note: `unsupported_ext: ${ext || "(none)"}` } as any;
}

async function extractAndWriteAttachmentTexts(
    source: string,
    pstSnDir: string,
    attachments: Array<{ name: string; saved_as: string; url: string }>,
    outBaseDir: string,
    maxChars: number,
    maxBytes: number,
    debug = false
): Promise<AttachmentTextInfo[]> {
    const out: AttachmentTextInfo[] = [];
    if (!attachments.length) return out;

    const dir = path.join(outBaseDir, source, `pstSn_${pstSnDir}`);
    fs.mkdirSync(dir, { recursive: true });

    for (const a of attachments) {
        const abs = path.resolve(process.cwd(), a.saved_as);
        const info: AttachmentTextInfo = { name: a.name, saved_as: a.saved_as };

        if (!fs.existsSync(abs)) {
            info.note = "missing_file";
            out.push(info);
            continue;
        }

        try {
            const st = fs.statSync(abs);
            if (st.size > maxBytes) {
                info.note = `skip_too_large: ${st.size}B`;
                out.push(info);
                continue;
            }
        } catch {
            info.note = "stat_failed";
            out.push(info);
            continue;
        }

        try {
            const extracted = await extractAttachmentText(abs, maxChars);

            if (typeof extracted === "object" && extracted && (extracted as any).__note) {
                info.note = String((extracted as any).__note);
                out.push(info);
                continue;
            }

            const text = String(extracted ?? "").trim();
            if (!text) {
                info.note = "empty_text";
                out.push(info);
                continue;
            }

            const outName = sanitizeFileName(`${path.basename(abs)}.txt`);
            const outPath = path.join(dir, outName);
            fs.writeFileSync(outPath, text, "utf8");

            info.text_path = posixRel(outPath);
            info.chars = text.length;
            out.push(info);

            if (debug) console.log("[ATT_TEXT_OK]", info.text_path, info.chars);
        } catch (e) {
            info.note = `extract_failed: ${String(e)}`;
            out.push(info);
        }
    }

    return out;
}

async function main() {
    const args = parseArgs(process.argv);

    const inputDir = String(args.htmlDir || "./corpus/raw");
    const outDir = String(args.outDir || "./corpus/derived/normalized");
    const minChars = Number(args.minChars || 200);
    const debug = Boolean(args.debug);

    const extractAttachments = asBool(args.extractAttachments, true);
    const attachMaxChars = Number(args.attachMaxChars || 50000);
    const attachMaxBytes = Number(args.attachMaxBytes || 8 * 1024 * 1024); // 8MB

    // ✅ attachOutDir은 절대경로로 고정
    const attachOutDir = path.resolve(
        String(args.attachOutDir || path.resolve(outDir, "..", "attachments_text"))
    );

    const absInput = path.resolve(inputDir);

    // pagesDir 결정
    let pagesDir = absInput;
    if (fs.existsSync(path.join(absInput, "pages")) && fs.statSync(path.join(absInput, "pages")).isDirectory()) {
        pagesDir = path.join(absInput, "pages");
    }

    // rawRoot 결정(attachments가 있는 쪽)
    let rawRoot = absInput;
    if (path.basename(absInput).toLowerCase() === "pages") {
        rawRoot = path.resolve(absInput, "..");
    } else if (!fs.existsSync(path.join(absInput, "attachments"))) {
        rawRoot = path.resolve(absInput, "..");
    }

    if (!fs.existsSync(pagesDir)) {
        console.error(`ERROR: pages dir not found: ${pagesDir}`);
        process.exit(1);
    }

    const all: string[] = [];
    walk(pagesDir, all);

    const htmlFiles = all.filter((p) => p.toLowerCase().endsWith(".html"));

    let n = 0;
    let nAttachText = 0;

    for (const f of htmlFiles) {
        const inferred = inferSourcePst(f);
        if (!inferred) continue;

        const buf = fs.readFileSync(f);
        const html = decodeHtmlSmart(buf, debug, posixRel(f));

        const plain = normalizeText(stripHtml(html));
        const mainPart = extractReadable(html, plain, debug, posixRel(f));
        const text = mainPart.text;

        if (text.length < minChars) continue;

        const title = mainPart.title || inferTitle(html, text);
        const date = inferDate(text);

        const attachments = listAttachments(rawRoot, inferred.source, inferred.pstSn, debug);

        // ✅ attachments_text 출력 dir은 숫자화된 pstDir 사용
        const pstDir = normalizePstDir(inferred.pstSn);

        let attachment_texts: AttachmentTextInfo[] | undefined = undefined;

        if (extractAttachments && attachments.length > 0) {
            attachment_texts = await extractAndWriteAttachmentTexts(
                inferred.source,
                pstDir,
                attachments,
                attachOutDir,
                attachMaxChars,
                attachMaxBytes,
                debug
            );
        }

        // ✅ 이미 존재하는 txt 산출물도 연결
        const hydrated = hydrateAttachmentTextsFromExistingTxts(
            inferred.source,
            inferred.pstSn,
            attachments,
            attachment_texts,
            attachOutDir,
            debug
        );
        attachment_texts = hydrated.attachment_texts;

        if (attachment_texts) {
            nAttachText += attachment_texts.filter((x) => x.text_path).length;
        }

        const raw_paths: Record<string, string> = { detail_html: posixRel(f) };

        // hydrate가 골라준 디렉토리가 있으면 신뢰
        if (hydrated.attachments_text_dir) {
            raw_paths.attachments_text_dir = hydrated.attachments_text_dir;
        } else {
            // 없으면, 이번 실행에서 만든 pstDir 쪽을 fallback
            const dirAbs = path.join(attachOutDir, inferred.source, `pstSn_${pstDir}`);
            if (attachment_texts?.some((x) => x.text_path) && fs.existsSync(dirAbs)) {
                raw_paths.attachments_text_dir = posixRel(dirAbs);
            }
        }

        const doc: NormalizedDocOut = {
            source: inferred.source,
            pstSn: inferred.pstSn,
            title: title || undefined,
            date: date || undefined,
            body_text: text,
            attachments,
            attachment_texts: attachment_texts && attachment_texts.length ? attachment_texts : undefined,
            fetched_at: new Date().toISOString(),
            raw_paths,
        };

        const outPath = path.join(outDir, doc.source, `pstSn_${doc.pstSn}.json`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), "utf8");
        n++;
    }

    console.log(`html_scanned: ${htmlFiles.length}`);
    console.log(`normalized_written: ${n}`);
    console.log(`attachments_text_written: ${nAttachText}`);
    console.log(`outDir: ${path.resolve(outDir)}`);
    console.log(`attachOutDir: ${path.resolve(attachOutDir)}`);
}

main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
});
