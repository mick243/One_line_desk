import { checkInput, maskLine } from '@one-line-desk/shared';
import { useMemo, useState, type FormEvent } from 'react';

interface Props {
  /** 입력 칸 머리. 묻기는 "나만 보여요", 같이 채워요는 "우리 층 모두에게 보여요"(D4). */
  scope: string;
  placeholder: string;
  submitLabel: string;
  disabledReason?: string;
  /** 가린 뒤의 글자만 넘겨요. 원문은 이 컴포넌트 상태(페이지 메모리)에만 있어요. */
  onSubmit?: (maskedText: string) => Promise<void> | void;
  value?: string;
  onValueChange?: (v: string) => void;
}

// 공통 입력 검사(ADR-11). 서버와 같은 규칙 파일을 써요.
export function CheckedInput({ scope, placeholder, submitLabel, disabledReason, onSubmit, value, onValueChange }: Props) {
  const [own, setOwn] = useState('');
  const text = value ?? own;
  const setText = onValueChange ?? setOwn;
  const [sending, setSending] = useState(false);
  const result = useMemo(() => checkInput(text), [text]);
  const line = maskLine(result);
  const locked = result.locks.length > 0;
  const blocked = locked || !text.trim() || sending || Boolean(disabledReason);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (blocked || !onSubmit) return;
    setSending(true);
    try {
      await onSubmit(result.text);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="checked-input" onSubmit={submit}>
      <div className="scope">{scope}</div>
      <div className="row">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={1000}
          aria-label={placeholder}
        />
        <button type="submit" disabled={blocked}>
          {sending ? '보내는 중' : submitLabel}
        </button>
      </div>
      {line && <p className="mask-line">{line}</p>}
      {result.locks.map((l) => (
        <p key={l.kind} className="lock-line" role="alert">
          {l.message}
        </p>
      ))}
      {disabledReason && <p className="hint">{disabledReason}</p>}
    </form>
  );
}
