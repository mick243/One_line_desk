import { useState } from 'react';

// 모의 어댑터가 하나라도 켜져 있으면 모든 화면 위에 띠 하나를 둬요(R6). 누르면 어떤 데이터가 모의인지 보여 줘요.
export function DemoBand({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className='demo-band'>
      <button type='button' onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        시연 데이터로 돌아가는 중이에요 · {open ? '접기' : '자세히'}
      </button>
      {open && (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
