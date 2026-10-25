import type { ReactNode } from 'react';

// 결과는 바닥 시트로 띄워요. 닫기·바깥 누르기로 닫혀요(화면설계 S2).
export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="handle" />
        <h2>{title}</h2>
        {children}
        <button type="button" className="secondary" onClick={onClose}>
          닫기
        </button>
      </section>
    </div>
  );
}
