export async function copyText(text: string): Promise<boolean> {
  const t = String(text ?? "").normalize("NFC");

  // 1) Clipboard API (보안 컨텍스트/권한 이슈가 잦아서 실패 시 즉시 폴백)
  try {
    const canClipboard =
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      !!navigator.clipboard?.writeText &&
      !!window.isSecureContext;

    if (canClipboard) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {
    // fall through
  }

  // 2) execCommand 폴백 (iOS/Safari 포함)
  try {
    if (typeof document === "undefined") return false;

    const ta = document.createElement("textarea");
    ta.value = t;

    // iOS에서 선택/복사 안정화
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";

    document.body.appendChild(ta);

    ta.focus({ preventScroll: true } as any);
    ta.select();
    try {
      ta.setSelectionRange(0, ta.value.length);
    } catch {
      // ignore
    }

    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
