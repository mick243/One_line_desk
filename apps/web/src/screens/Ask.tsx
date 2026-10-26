// S1 묻기(앞문)
import type { AskResponse, Kind, ModuleKind, ModuleSwitch } from '@one-line-desk/shared';
import { useState } from 'react';
import { api } from '../api';
import { CheckedInput } from '../components/CheckedInput';
import { ResultSheet } from '../components/ResultSheet';
import { Sheet } from '../components/Sheet';
import { webModules } from '../modules/registry';

// 예시 칩은 켜진 모듈 것만 보여요(ADR-12 끄기 스위치).
const EXAMPLES: { kind: ModuleKind; text: string }[] = [
  { kind: 'navi', text: '법인카드 잃어버렸어요' },
  { kind: 'rooms', text: '내일 3시 6명 회의실' },
  { kind: 'pantry', text: '제로콜라 요청' },
];

// 예시 칩은 입력창에 채우기만 하고 보내지 않아요. 보낸 문장은 이 화면 메모리에만 있어요(R13).
export function Ask({
  modules,
  onShowRetention,
  initialText = '',
}: {
  modules: Record<ModuleKind, ModuleSwitch>;
  onShowRetention: () => void;
  initialText?: string;
}) {
  const [text, setText] = useState(initialText);
  const [sent, setSent] = useState<string | null>(null);
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null);
  const { MyReservations, MyRequests } = webModules;

  async function ask(masked: string, kind?: Kind) {
    setSent(masked);
    setResponse(null);
    setLoading(true);
    const result = await api.ask(masked, kind);
    setLoading(false);
    if (result.status === 'ok') {
      setResponse(result.response);
      return;
    }
    setSent(null);
    if (result.status === 'locked') setNotice({ title: '보낼 수 없어요', lines: result.locks.map((l) => l.message) });
    else setNotice({ title: '결과', lines: [result.message] });
  }

  return (
    <div className='ask'>
      <header className='screen-head'>
        <h1>한 줄 데스크</h1>
      </header>

      <MyReservations compact />
      <MyRequests compact />

      <div className='chips' aria-label='예시 문장'>
        {EXAMPLES.filter((ex) => modules[ex.kind] === 'on').map((ex) => (
          <button key={ex.text} type='button' className='chip' onClick={() => setText(ex.text)}>
            {ex.text}
          </button>
        ))}
      </div>

      <div className='dock'>
        <CheckedInput
          scope='나만 보여요'
          placeholder='이거 어디서 해요? 한 줄로 물어보세요'
          submitLabel='보내기'
          value={text}
          onValueChange={setText}
          onSubmit={(masked) => ask(masked)}
        />
        <button type='button' className='link' onClick={onShowRetention}>
          질문 원문은 저장하지 않아요 · 무엇을 남기나요
        </button>
      </div>

      {sent !== null && (
        <ResultSheet
          response={response}
          loading={loading}
          onReask={(kind) => void ask(sent, kind)}
          onClose={() => {
            setSent(null);
            setResponse(null);
          }}
        />
      )}
      {notice && (
        <Sheet title={notice.title} onClose={() => setNotice(null)}>
          {notice.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </Sheet>
      )}
    </div>
  );
}
