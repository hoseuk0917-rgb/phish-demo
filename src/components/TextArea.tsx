// src/components/TextArea.tsx
import React from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
};

export const TextArea = React.forwardRef<HTMLTextAreaElement, Props>(function TextArea(
  { value, onChange, onKeyDown },
  ref
) {
  return (
    <textarea
      ref={ref}
      className="textarea"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="여러 메시지를 그대로 붙여넣어도 됩니다. (시간/이름 포함 로그 OK)"
      spellCheck={false}
    />
  );
});
