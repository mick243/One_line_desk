import { Children, isValidElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// 옆으로 넘치는 칩 한 줄(10/28). 휴대폰은 손가락으로 밀고, PC는 마우스 휠이나 끌기(11/3)로도 옆으로 넘겨요.
// 끌어서 넘긴 뒤 손을 떼면 칩이 눌리지 않아요(5px 넘게 움직였을 때만 끌기로 봐요).
// 넘칠 때만 가장자리를 흐리게 해서 "옆에 더 있어요"를 보여 주고, PC에서는 얇은 막대도 보여요(styles.css .scroll-x).
// 줄 끝에 닿았거나 넘치지 않으면 휠은 페이지를 그대로 내려요.
// 11/5(처음 쓰는 직원 점검: 칩이 잘려 보여요): 넘칠 때 끝에 [›]·[‹] 버튼을 둬서 옆에 더 있다는 걸 보이고, 누르면 한 화면씩 넘겨요.

interface Edges {
  overflow: boolean;
  start: boolean;
  end: boolean;
}

export function ScrollChips({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ overflow: false, start: true, end: true });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = {
      overflow: el.scrollWidth > el.clientWidth + 1,
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    };
    setEdges((prev) => (prev.overflow === next.overflow && prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 세로 휠을 옆으로 바꿔요. 이미 옆으로 굴리는 휠(트랙패드)은 그대로 둬요.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
    };
    // 마우스로 끌어서 옆으로 넘겨요. 손가락·펜은 브라우저가 알아서 밀어요.
    let drag: { x: number; left: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || el.scrollWidth <= el.clientWidth) return;
      drag = { x: e.clientX, left: el.scrollLeft, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        el.setPointerCapture(e.pointerId);
        el.dataset.dragging = 'true';
      }
      el.scrollLeft = drag.left - dx;
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      if (drag.moved) {
        // 끌기가 끝난 바로 그 클릭은 칩에 닿지 않게 한 번 막아요.
        el.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true });
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        delete el.dataset.dragging;
      }
      drag = null;
    };
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      resize.disconnect();
    };
  }, [measure]);

  // 칩이 바뀌면(최근 쓴 문장이 늘거나 지워지면) 넘치는지 다시 재요. 렌더마다 재지 않고 칩 key 목록이 바뀔 때만요.
  const chipKeys = Children.toArray(children)
    .map((c) => (isValidElement(c) ? String(c.key) : ''))
    .join('\n');
  useEffect(measure, [chipKeys, measure]);

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.8), behavior: 'smooth' });
  };

  return (
    <div className='scroll-chips'>
      <div ref={ref} className='chips scroll scroll-x' aria-label={label} data-overflow={edges.overflow} data-start={edges.start} data-end={edges.end}>
        {children}
      </div>
      {edges.overflow && !edges.start && (
        <button type='button' className='scroll-chips-arrow prev' aria-label={`${label} 앞으로 넘기기`} onClick={() => page(-1)}>
          <Icon name='chevron' size={18} />
        </button>
      )}
      {edges.overflow && !edges.end && (
        <button type='button' className='scroll-chips-arrow next' aria-label={`${label} 더 보기`} onClick={() => page(1)}>
          <Icon name='chevron' size={18} />
        </button>
      )}
    </div>
  );
}
