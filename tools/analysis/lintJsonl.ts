// tools/analysis/lintJsonl.ts
import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

type AnyObj = Record<string, any>;

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

function stripBom(s: string) {
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function tryParseLine(line: string) {
    let s = stripBom(line.trim());
    if (!s) return { ok: false as const, skip: true as const };

    // 흔한 깨짐 패턴 최소 복구
    s = s.replace(/\\\s+n/g, "\\n").replace(/\\\s+r/g, "\\r");
    s = s.replace(/,\s*([}\]])/g, "$1"); // trailing comma
    s = s.replace(/\u0000/g, "");

    try {
        const obj = JSON.parse(s);
        return { ok: true as const, obj };
    } catch (e1) {
        return { ok: false as const, err: String((e1 as any)?.message || e1), raw: s };
    }
}

function main() {
    const args = parseArgs(process.argv);
    const inPath = String(args.in || "");
    const outPath = String(args.out || "");
    const badPath = String(args.bad || "");
    const encoding = String(args.encoding || "auto").toLowerCase(); // auto|utf8|cp949

    if (!inPath || !outPath) {
        console.error("Usage: --in <path> --out <path> [--bad <path>] [--encoding auto|utf8|cp949]");
        process.exit(1);
    }
    if (!fs.existsSync(inPath)) {
        console.error(`ERROR: not found: ${inPath}`);
        process.exit(1);
    }

    const buf = fs.readFileSync(inPath);

    const decode = (enc: string) => stripBom(iconv.decode(buf, enc));
    const tryDecode = (enc: string) =>
        decode(enc).split(/\r?\n/g).filter((l) => l.trim() && !l.trim().startsWith("#"));

    let lines: string[] = [];
    if (encoding === "utf8") lines = tryDecode("utf8");
    else if (encoding === "cp949") lines = tryDecode("cp949");
    else {
        // auto: utf8로 먼저 파싱 성공률 체크, 낮으면 cp949 시도
        const u = tryDecode("utf8");
        let okU = 0;
        for (const l of u.slice(0, Math.min(50, u.length))) if (tryParseLine(l).ok) okU++;
        const rateU = u.length ? okU / Math.min(50, u.length) : 1;

        if (rateU >= 0.8) lines = u;
        else lines = tryDecode("cp949");
    }

    const out: string[] = [];
    const bad: string[] = [];
    let ok = 0, fail = 0, skip = 0;

    for (let i = 0; i < lines.length; i++) {
        const r = tryParseLine(lines[i]);
        const lineNo = i + 1;
        if ((r as any).skip) { skip++; continue; }
        if ((r as any).ok) {
            ok++;
            out.push(JSON.stringify((r as any).obj));
        } else {
            fail++;
            bad.push(`[${lineNo}] ${(r as any).err}\n${(r as any).raw}\n`);
        }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");

    if (badPath) {
        fs.mkdirSync(path.dirname(badPath), { recursive: true });
        fs.writeFileSync(badPath, bad.join("\n"), "utf8");
    }

    console.log(`in:  ${path.resolve(inPath)}`);
    console.log(`out: ${path.resolve(outPath)}`);
    if (badPath) console.log(`bad: ${path.resolve(badPath)}`);
    console.log(`ok=${ok}, fail=${fail}, skip=${skip}, total=${lines.length}`);
}

main();
