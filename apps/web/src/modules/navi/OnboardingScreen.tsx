import type { CardAction, OnboardingResponse } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { InquirySheet } from './InquirySheet';
import './navi.css';

// 신규 입사자 첫 2주 할 일(10/31 넓힐 후보 ①). 담당 찾기 탭 아래 화면이에요.
// 분장표 "온보딩 주차" 칸이 붙은 업무를 1·2주차로 묶어 보여 줘요. 누구나 열 수 있고, 신규 입사자인지는 묻지 않아요.
// 누가 무엇을 했는지(진행)는 저장하지 않아서 체크 상자를 두지 않아요. 있으면 저장되는 줄 알아요(10/31 디자이너).

type Inquire = Extract<CardAction, { type: 'inquire' }>;

export function OnboardingScreen({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<OnboardingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inquiry, setInquiry] = useState<Inquire | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<OnboardingResponse>('GET', '/api/navi/onboarding')
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof ApiFailure ? e.message : '지금 불러오지 못했어요'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className='feature-page onboarding'>
      <button type='button' className='link back' onClick={onBack}>
        ← 담당 찾기
      </button>
      <header className='page-head'>
        <p className='eyebrow'>담당 찾기</p>
        <h1>처음 2주에 할 일이에요</h1>
        <p className='lead'>업무 분장표에서 새로 온 분이 먼저 챙기면 좋은 일을 모았어요. 무엇을 했는지는 저장하지 않아요.</p>
      </header>

      {error && (
        <p className='lock-line' role='alert'>
          {error}
        </p>
      )}
      {!data && !error && <div className='skeleton' aria-label='불러오는 중' />}
      {data && data.weeks.length === 0 && <p className='empty'>아직 분장표에 첫 2주 할 일이 없어요. 담당 찾기에서 한 줄로 물어보세요.</p>}
      {data?.weeks.map((w) => (
        <section key={w.week} className='card onboarding-week'>
          <h2>{w.week}주차</h2>
          <ol className='onboarding-list'>
            {w.items.map((item) => (
              <li key={item.rowId}>
                <p className='onboarding-task'>
                  <strong>{item.task}</strong> <span className='hint'>· {item.team}</span>
                </p>
                <p>{item.nextStep}</p>
                <p className='hint'>
                  창구: {item.desk}
                  {item.processingPeriod ? ` · 처리 기간 ${item.processingPeriod}` : ''}
                </p>
                <div className='card-actions'>
                  {item.deskUrl && (
                    <a className='link' href={item.deskUrl} target='_blank' rel='noopener noreferrer'>
                      창구 열기
                    </a>
                  )}
                  <button
                    type='button'
                    className='secondary small'
                    onClick={() => setInquiry({ type: 'inquire', text: `${item.team}에 문의하기`, rowId: item.rowId, team: item.team, task: item.task })}
                  >
                    {item.team}에 문의하기
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <p className='evidence'>근거: 업무 분장표 "온보딩 주차" 칸 · 행마다 개정일이 달라요</p>
        </section>
      ))}

      {inquiry && <InquirySheet action={inquiry} initialQuestion='' onClose={() => setInquiry(null)} />}
    </div>
  );
}
