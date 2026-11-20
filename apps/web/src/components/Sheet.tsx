import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createSheetHistory } from './sheet-history';

// 결과는 바닥 시트로 띄워요. 닫기·바깥 누르기·Esc·아래로 밀기·뒤로 가기로 닫혀요(화면설계 S2, PRD 접근성 "뒤로 가기 한 번이면 닫혀요").
// 어느 부품 안에서 열어도 화면 전체를 덮도록 body에 그려요(위 막대·아래 탭에 갇히거나 가리지 않게).
// 키보드·화면 읽기(QA-17, L-47): 열면 시트 안으로 초점이 가고, Tab은 시트 안에서만 돌고, 닫으면 연 자리로 돌아가요.
// 시트 위에 시트가 열리면 Esc·뒤로 가기는 맨 위 시트만 닫고, 그 아래(앱·아래 시트)는 inert라 읽히지도 눌리지도 않아요.
// 뒤로 가기(11/11 QA P1·U1): 열린 시트마다 방문 기록을 하나 더해서, 휴대폰 뒤로 가기가 아래 페이지를 바꾸지 않고 맨 위 시트만 닫아요.
// 기록에는 페이지 이름과 시트 수만 넣어요. 쓰던 글은 넣지 않아요(R13). 쓴 글이 있는 양식(dirty)은 닫기 전에 한 번 물어요.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** 손잡이를 이만큼 아래로 끌면 닫아요(px) */
const SWIPE_CLOSE = 80;
export const SHEET_DISCARD_TEXT = { ask: '쓴 글이 사라져요. 닫을까요?', discard: '닫기', keep: '계속 쓰기' } as const;

/** 열린 시트 순서. 마지막이 맨 위예요. requestClose는 사람이 닫으려 할 때예요(쓴 글이 있으면 먼저 물어요). */
const stack: { el: HTMLElement; requestClose: () => void }[] = [];

function syncInert() {
  const top = stack.at(-1)?.el;
  document.getElementById('root')?.toggleAttribute('inert', stack.length > 0);
  for (const { el } of stack) el.toggleAttribute('inert', el !== top);
}

// 방문 기록(뒤로 가기로 맨 위 시트 닫기)은 sheet-history.ts가 맡아요. 앱보다 먼저(모듈을 불러올 때) popstate를 들어요.
const sheetHistory =
  typeof window === 'undefined'
    ? null
    : createSheetHistory({ history: () => window.history, href: () => window.location.href, defer: (fn) => setTimeout(fn, 0) });
if (typeof window !== 'undefined') window.addEventListener('popstate', (e) => sheetHistory?.onPop(e));

/** 지금 방문 기록 맨 위가 시트 줄인지. 시트가 열린 채 페이지를 옮기면 App이 시트 줄을 새 페이지로 바꿔 써요(뒤로 가기 한 번이 헛돌지 않게). */
export const atSheetEntry = (): boolean => sheetHistory?.atSheetEntry() ?? false;

/** 이 popstate를 시트가 처리했는지(뒤로 가기로 시트를 닫음). App은 그때 페이지를 바꾸지 않아요. */
export const sheetHandledPop = (e: Event): boolean => sheetHistory?.handled(e) ?? false;

export function Sheet({ title, children, onClose, dirty = false }: { title: string; children: ReactNode; onClose: () => void; dirty?: boolean }) {
  const backdrop = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const [asking, setAsking] = useState(false);
  const [drag, setDrag] = useState<{ startY: number; dy: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // 사람이 닫으려 할 때(닫기·바깥·Esc·밀기·뒤로 가기). 쓴 글이 있으면 먼저 물어요.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const requestClose = useRef(() => (dirtyRef.current ? setAsking(true) : close.current()));

  useEffect(() => {
    const el = backdrop.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const item = { el, requestClose: () => requestClose.current() };
    stack.push(item);
    syncInert();
    const left = sheetHistory?.opened(item);
    // 시트 머리(제목)부터 읽히게 시트 자체에 초점을 둬요. Tab을 누르면 첫 버튼·칸으로 가요.
    sheet.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1)?.el !== el) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose.current();
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
      stack.splice(stack.indexOf(item), 1);
      syncInert();
      left?.();
      // 연 버튼이 아직 화면에 있으면 그리로 돌아가요.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // 손잡이를 아래로 끌어 닫기(화면설계 S2 "아래로 밀기"). 끄는 동안은 transform만 바꿔요.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ startY: e.clientY, dy: 0 });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ startY: drag.startY, dy: Math.max(0, e.clientY - drag.startY) });
  };
  const onPointerEnd = () => {
    if (drag && drag.dy >= SWIPE_CLOSE) requestClose.current();
    setDrag(null);
  };

  return createPortal(
    <div className='sheet-backdrop' ref={backdrop} onClick={() => requestClose.current()}>
      <section
        className='sheet'
        role='dialog'
        aria-modal='true'
        aria-label={title}
        tabIndex={-1}
        ref={sheet}
        onClick={(e) => e.stopPropagation()}
        style={drag && drag.dy > 0 ? { transform: `translateY(${drag.dy}px)` } : undefined}
      >
        <div
          className='handle'
          role='presentation'
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={() => setDrag(null)}
        />
        <h2>{title}</h2>
        <div className='sheet-body'>{children}</div>
        {asking ? (
          <div className='sheet-discard' role='alert'>
            <p>{SHEET_DISCARD_TEXT.ask}</p>
            <div className='card-actions'>
              <button type='button' className='secondary' onClick={() => setAsking(false)}>
                {SHEET_DISCARD_TEXT.keep}
              </button>
              <button type='button' className='neutral' onClick={() => close.current()}>
                {SHEET_DISCARD_TEXT.discard}
              </button>
            </div>
          </div>
        ) : (
          <button type='button' className='neutral' onClick={() => requestClose.current()}>
            닫기
          </button>
        )}
      </section>
    </div>,
    document.body,
  );
}
