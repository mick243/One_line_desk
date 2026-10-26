import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';

// 결과는 바닥 시트로 띄워요. 닫기·바깥 누르기·Esc로 닫혀요(화면설계 S2).
// 어느 부품 안에서 열어도 화면 전체를 덮도록 body에 그려요(위 막대·아래 탭에 갇히거나 가리지 않게).
export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className='sheet-backdrop' onClick={onClose}>
      <section className='sheet' role='dialog' aria-modal='true' aria-label={title} onClick={(e) => e.stopPropagation()}>
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
