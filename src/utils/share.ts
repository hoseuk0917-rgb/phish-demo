import { copyText } from "./clipboard";

export async function shareText(text: string, title = "phish-demo"): Promise<boolean> {
    try {
        const t = String(text ?? "").normalize("NFC");
        if (!t) return false;

        const nav: any = navigator as any;

        // Web Share API (모바일에서 카톡/SMS/메일/메모 등 공유 시트)
        if (nav?.share) {
            try {
                // canShare는 지원 브라우저에서만
                if (nav.canShare && !nav.canShare({ text: t })) {
                    // canShare가 false면 copy로 폴백
                    return await copyText(t);
                }
                await nav.share({ title, text: t });
                return true;
            } catch (err: any) {
                // 사용자가 공유 시트를 닫는 경우(AbortError)는 "실패"로 굳이 취급하지 않음
                const name = String(err?.name || "");
                if (/AbortError/i.test(name)) return false;
                return await copyText(t);
            }
        }

        // 미지원이면 복사로 폴백
        return await copyText(t);
    } catch {
        return false;
    }
}
