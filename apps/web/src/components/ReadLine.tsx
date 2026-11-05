import type { ReadNote } from '@one-line-desk/shared';

// 알아들은 것(11/5 시험, AI 보완 2번). 서버가 준 해석 라벨만 보여 줘요(질문 글은 다시 받지 않아요).
// AI가 낱말 규칙과 다르게 봤으면 "낱말로만 보면 ○○"를 같이 보여 줘서, AI가 무엇을 바로잡았는지 보이게 해요.
// 되돌릴 기준: #30 머지 상태(이 파일째 지워요).

export function ReadLine({ read, ai }: { read?: ReadNote; ai: boolean }) {
  if (!read) return null;
  return (
    <p className='read-line'>
      <span className='read-label'>{ai ? 'AI가 알아들은 것' : '알아들은 것'}</span>
      <span>{read.understood}</span>
      {read.ruleSaid && <span className='read-diff'>낱말로만 보면 "{read.ruleSaid}"예요. AI가 문장 뜻으로 다시 봤어요</span>}
    </p>
  );
}
