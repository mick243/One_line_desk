import type { AiEvalResponse, NoticeEvalAnswer, NoticeEvalSide, NoticeEvalView } from '@one-line-desk/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../api';

// 관리자 화면 "AI 정답률"(11/5 시험, AI 보완 1번). 운영자(관리자)만 들어와요. 서버도 운영자가 아니면 403이에요.
// 정답 단 가상 문장으로 낱말 규칙과 AI가 몇 개 맞히는지 비교해요. 직원이 쓴 글은 쓰지 않아요.
// 11/6부터 가상 공지의 알림 대상 제안도 같이 봐요(놓친 사람·더 받은 사람, ADR-09). 되돌릴 때도 이 칸은 남겨요.
// 되돌릴 기준: #30 머지 상태(이 파일째 지워요).

const POLL_MS = 3000;

const pct = (n: number, total: number) => `${n}/${total} (${total ? Math.round((n / total) * 100) : 0}%)`;

/** "✗ 낱말 규칙: 인사팀 · 5층 · 놓침 0명 · 더 받음 6명" */
function answerLine(who: string, a: NoticeEvalAnswer) {
  const people = a.missed === null ? '' : ` · 놓침 ${a.missed}명 · 더 받음 ${a.extra}명`;
  return (
    <p className={a.ok ? 'eval-ok' : 'eval-wrong'}>
      {a.ok ? '✓' : '✗'} {who}: {a.label}
      {a.ok ? '' : people}
    </p>
  );
}

/**
 * 공지 알림 대상(11/6, ADR-09 개정). 가상 공지에 받아야 할 사람을 정답으로 달고, 제안이 놓친 사람·더 받은 사람을 가상 직원 수로 세요.
 * 자동 보내기를 켤지 볼 때는 놓친 사람을 먼저 봐요. 이름은 없고 수만이에요.
 */
function NoticeAudienceEval({ n }: { n: NoticeEvalView }) {
  const cells = (s: NoticeEvalSide | null) =>
    s === null ? (
      <>
        <td className='num'>안 잼</td>
        <td className='num'>안 잼</td>
        <td className='num'>안 잼</td>
        <td className='num'>안 잼</td>
      </>
    ) : (
      <>
        <td className='num'>{pct(s.exact, n.total)}</td>
        <td className='num'>{pct(s.missedNone, n.total)}</td>
        <td className='num'>
          {s.missed}명 / {n.shouldGet}명
        </td>
        <td className='num'>{s.extra}명</td>
      </>
    );
  return (
    <section className='card'>
      <h2>공지 알림 대상</h2>
      <p className='hint'>
        가상 공지 {n.total}건에 받아야 할 사람을 정답으로 달았어요. 사람 수는 가상 직원 {n.people}명으로 세요. 자동 보내기를 켤지 볼 때는 "놓친 사람"을 먼저
        봐요.
      </p>
      <div className='eval-table-wrap'>
        <table className='eval-table'>
          <thead>
            <tr>
              <th>제안하는 곳</th>
              <th className='num'>정확히 맞힘</th>
              <th className='num'>놓친 사람 0인 공지</th>
              <th className='num'>놓친 사람</th>
              <th className='num'>더 받은 사람</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>낱말 규칙</td>
              {cells(n.rule)}
            </tr>
            <tr>
              <td>AI</td>
              {cells(n.ai)}
            </tr>
          </tbody>
        </table>
      </div>
      {n.ai !== null && n.ai.failed > 0 && <p className='hint'>AI가 답하지 못한 공지가 {n.ai.failed}건이에요.</p>}
      <h3>틀린 공지</h3>
      {n.misses.length === 0 ? (
        <p className='empty'>틀린 공지가 없어요.</p>
      ) : (
        <ul className='plain eval-misses'>
          {n.misses.map((m) => (
            <li key={m.title}>
              <p>
                <strong>{m.title}</strong> <span className='hint'>· {m.group}</span>
              </p>
              <p className='hint'>{m.body}</p>
              <p className='hint'>정답: {m.expect}</p>
              {answerLine('낱말 규칙', m.rule)}
              {m.ai !== null && answerLine('AI', m.ai)}
              {m.why && <p className='hint'>{m.why}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AiEvalScreen({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<AiEvalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    try {
      setData(await apiRequest<AiEvalResponse>('GET', '/api/ops/ai-eval', undefined, { background }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '표를 불러오지 못했어요');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 재는 중이면 몇 초마다 다시 불러요. 사람이 누르지 않는 반복 요청이라 background로 보내요(쉬는 시간을 늘리지 않아요, ADR-20).
  const running = data?.run.running ?? false;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(id);
  }, [running, load]);

  async function run() {
    try {
      setData(await apiRequest<AiEvalResponse>('POST', '/api/ops/ai-eval/run'));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 잴 수 없어요');
    }
  }

  const all = data?.scores.reduce((a, s) => ({ total: a.total + s.total, rule: a.rule + s.rule, ai: s.ai === null || a.ai === null ? null : a.ai + s.ai }), {
    total: 0,
    rule: 0,
    ai: 0 as number | null,
  });

  return (
    <div className='feature-page ai-eval'>
      <button type='button' className='link back' onClick={onBack}>
        ← 마이 페이지
      </button>
      <header className='page-head'>
        <p className='eyebrow'>운영자만 봐요</p>
        <h1>AI 정답률</h1>
        <p className='lead'>정답을 단 가상 문장·공지로 낱말 규칙과 AI가 각각 몇 개 맞히는지 비교해요. 직원이 쓴 글은 쓰지 않아요.</p>
      </header>

      {error && <p className='lock-line'>{error}</p>}
      {!data && !error && <div className='skeleton' aria-label='표를 불러오는 중' />}

      {data && all && (
        <>
          <section className='card'>
            <div className='eval-head'>
              <p className='hint'>
                {data.measured ? `AI로 잰 때 ${data.measured.at} · 모델 ${data.measured.model}` : 'AI로는 아직 안 쟀어요. 낱말 규칙은 열 때마다 세요.'}
              </p>
              <button type='button' className='secondary small' disabled={!data.run.allowed} onClick={() => void run()}>
                {running ? '재는 중…' : 'AI로 다시 재기'}
              </button>
            </div>
            {data.run.reason && !running && <p className='hint'>{data.run.reason}</p>}
            {running && (
              <p className='hint'>
                문장 {all.total}개와 공지 {data.notices.total}건을 AI에 보내고 있어요. 2분쯤 걸려요.
              </p>
            )}
            <div className='eval-table-wrap'>
              <table className='eval-table'>
                <thead>
                  <tr>
                    <th>해석하는 곳</th>
                    <th className='num'>문장</th>
                    <th className='num'>낱말 규칙</th>
                    <th className='num'>AI</th>
                    <th className='num'>AI만 맞힘</th>
                  </tr>
                </thead>
                <tbody>
                  {data.scores.map((s) => (
                    <tr key={s.task}>
                      <td>{s.label}</td>
                      <td className='num'>{s.total}</td>
                      <td className='num'>{pct(s.rule, s.total)}</td>
                      <td className='num'>{s.ai === null ? '안 잼' : pct(s.ai, s.total)}</td>
                      <td className='num'>{s.ai === null ? '—' : s.aiOnly}</td>
                    </tr>
                  ))}
                  <tr className='eval-total'>
                    <td>모두</td>
                    <td className='num'>{all.total}</td>
                    <td className='num'>{pct(all.rule, all.total)}</td>
                    <td className='num'>{all.ai === null ? '안 잼' : pct(all.ai, all.total)}</td>
                    <td className='num' />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className='card'>
            <h2>틀린 문장</h2>
            <p className='hint'>정답은 "이렇게 나눠야 맞다"예요. 지금 규칙이 하는 대로 적지 않아서 규칙의 빈틈이 보여요.</p>
            {data.misses.length === 0 ? (
              <p className='empty'>틀린 문장이 없어요.</p>
            ) : (
              <ul className='plain eval-misses'>
                {data.misses.map((m) => (
                  <li key={`${m.label}-${m.text}`}>
                    <p>
                      <strong>{m.text}</strong> <span className='hint'>· {m.label}</span>
                    </p>
                    <p className='hint'>정답: {m.expect}</p>
                    <p className={m.ruleOk ? 'eval-ok' : 'eval-wrong'}>
                      {m.ruleOk ? '✓' : '✗'} 낱말 규칙: {m.rule}
                    </p>
                    {m.ai !== null && (
                      <p className={m.aiOk ? 'eval-ok' : 'eval-wrong'}>
                        {m.aiOk ? '✓' : '✗'} AI: {m.ai}
                      </p>
                    )}
                    {m.why && <p className='hint'>{m.why}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <NoticeAudienceEval n={data.notices} />
        </>
      )}
    </div>
  );
}
