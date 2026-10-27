import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// 결과는 바닥 시트로 띄워요. 닫기·바깥 누르기·Esc로 닫혀요(화면설계 S2).
// 어느 부품 안에서 열어도 화면 전체를 덮도록 body에 그려요(위 막대·아래 탭에 갇히거나 가리지 않게).
// 키보드·화면 읽기(QA-17, L-47): 열면 시트 안으로 초점이 가고, Tab은 시트 안에서만 돌고, 닫으면 연 자리로 돌아가요.
// 시트 위에 시트가 열리면 Esc는 맨 위 시트만 닫고, 그 아래(앱·아래 시트)는 inert라 읽히지도 눌리지도 않아요.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 열린 시트 순서. 마지막이 맨 위예요. */
const stack: HTMLElement[] = [];

function syncInert() {
  const top = stack.at(-1);
  document.getElementById('root')?.toggleAttribute('inert', stack.length > 0);
  for (const el of stack) el.toggleAttribute('inert', el !== top);
}

export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const backdrop = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = backdrop.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(el);
    syncInert();
    // 시트 머리(제목)부터 읽히게 시트 자체에 초점을 둬요. Tab을 누르면 첫 버튼·칸으로 가요.
    sheet.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1) !== el) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...sheet.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === sheet.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !sheet.current!.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(el), 1);
      syncInert();
      // 연 버튼이 아직 화면에 있으면 그리로 돌아가요.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div className='sheet-backdrop' ref={backdrop} onClick={onClose}>
      <section className='sheet' role='dialog' aria-modal='true' aria-label={title} tabIndex={-1} ref={sheet} onClick={(e) => e.stopPropagation()}>
        <div className='handle' />
        <h2>{title}</h2>
        <div className='sheet-body'>{children}</div>
        <button type='button' className='neutral' onClick={onClose}>
          닫기
        </button>
      </section>
    </div>,
    document.body,
  );
}
