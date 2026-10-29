import { useEffect, useState } from 'react';
import { newVersionAvailable, onNewVersion } from '../api';

/** 입력 칸에 쓰던 글이 있는지. 새로 고치면 글이 사라져서(저장하지 않아요, R13) 먼저 보내라고 해요. */
function hasDraft(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type="text"], input[type="search"], input:not([type])'),
  ).some((el) => el.value.trim() !== '');
}

// 배포 뒤 오래 연 탭이 새 판을 알아채면 띄워요(10/29 배포 준비 회의 D1). 저절로 새로 고치지 않아요.
// 닫으면 이 화면을 쓰는 동안은 다시 띄우지 않아요(메모리에만 기억해요).
export function VersionBand() {
  const [shown, setShown] = useState(newVersionAvailable);
  const [closed, setClosed] = useState(false);
  const [draft, setDraft] = useState(false);
  useEffect(() => onNewVersion(() => setShown(true)), []);
  // 화면이 바뀐 뒤(그려진 뒤)에도 다시 봐요. 로그인 화면으로 넘어가 입력 칸이 사라지면 "쓰던 글" 문구도 빼요.
  useEffect(() => {
    if (shown) setDraft(hasDraft());
  });
  useEffect(() => {
    if (!shown) return;
    const check = () => setDraft(hasDraft());
    document.addEventListener('input', check);
    return () => document.removeEventListener('input', check);
  }, [shown]);
  if (!shown || closed) return null;
  return (
    <div className='version-band' role='status'>
      <span>{draft ? '새 버전이 있어요. 쓰던 글을 보낸 뒤 새로 고쳐 주세요' : '새 버전이 있어요'}</span>
      <button type='button' onClick={() => window.location.reload()}>
        새로 고침
      </button>
      <button type='button' className='version-band-close' aria-label='새 버전 알림 닫기' onClick={() => setClosed(true)}>
        ×
      </button>
    </div>
  );
}
