import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

// 옆으로 넘치는 칩 한 줄(10/28). 휴대폰은 손가락으로 밀고, PC는 마우스 휠로도 옆으로 넘겨요.
// 넘칠 때만 가장자리를 흐리게 해서 "옆에 더 있어요"를 보여 주고, PC에서는 얇은 막대도 보여요(styles.css .scroll-x).
// 줄 끝에 닿았거나 넘치지 않으면 휠은 페이지를 그대로 내려요.

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
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
      resize.disconnect();
    };
  }, [measure]);

  // 칩이 바뀌면(최근 쓴 문장이 늘거나 지워지면) 넘치는지 다시 재요.
  useEffect(measure, [children, measure]);

  return (
    <div ref={ref} className='chips scroll scroll-x' aria-label={label} data-overflow={edges.overflow} data-start={edges.start} data-end={edges.end}>
      {children}
    </div>
  );
}
