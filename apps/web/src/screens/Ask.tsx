import { useState } from 'react';
import { api, type AskResult } from '../api';
import { CheckedInput } from '../components/CheckedInput';
import { Sheet } from '../components/Sheet';

const EXAMPLES = ['법인카드 잃어버렸어요', '내일 3시 6명 회의실', '제로콜라 요청'];

// S1 묻기(앞문). 예시 칩은 입력창에 채우기만 하고 보내지 않아요.
export function Ask({ onShowRetention }: { onShowRetention: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);

  return (
    <div className="ask">
      <header className="screen-head">
        <h1>한 줄 데스크</h1>
      </header>

      <section className="card">
        <h2>내 예약</h2>
        <p className="empty">아직 예약이 없어요.</p>
      </section>
      <section className="card">
        <h2>내 요청</h2>
        <p className="empty">아직 요청이 없어요.</p>
      </section>

      <div className="chips" aria-label="예시 문장">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="chip" onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>

      <div className="dock">
        <CheckedInput
          scope="나만 보여요"
          placeholder="이거 어디서 해요? 한 줄로 물어보세요"
          submitLabel="보내기"
          value={text}
          onValueChange={setText}
          onSubmit={async (masked) => setResult(await api.ask(masked))}
        />
        <button type="button" className="link" onClick={onShowRetention}>
          질문 원문은 저장하지 않아요 · 무엇을 남기나요
        </button>
      </div>

      {result && (
        <Sheet title={result.status === 'locked' ? '보낼 수 없어요' : '결과'} onClose={() => setResult(null)}>
          {result.status === 'locked' ? result.locks.map((l) => <p key={l.kind}>{l.message}</p>) : <p>{result.message}</p>}
        </Sheet>
      )}
    </div>
  );
}
