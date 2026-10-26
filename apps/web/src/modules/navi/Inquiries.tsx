import { INQUIRY_STATE_LABEL, type InquiryItem, type InquiryListResponse } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';

// 받은 문의함(내 부서로 온 문의)과 내 문의(내가 보낸 문의). 담당 찾기 페이지 아래에 있어요(ADR-16).

function when(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 ${iso.slice(11, 16)}`;
}

function useInquiries(path: string) {
  const { version } = useActions();
  const [data, setData] = useState<InquiryListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiRequest<InquiryListResponse>('GET', path)
      .then((res) => alive && (setData(res), setError(null)))
      .catch((e) => alive && setError(e instanceof ApiFailure ? e.message : '문의를 불러오지 못했어요'));
    return () => {
      alive = false;
    };
  }, [path, version]);
  return { data, error };
}

function StateBadge({ item }: { item: InquiryItem }) {
  return <span className={`inquiry-state ${item.state}`}>{INQUIRY_STATE_LABEL[item.state]}</span>;
}

/** 받은 문의함: 분장표에 행이 있는 부서만 보여요. [확인했어요]·[처리했어요]를 누르면 보낸 사람에게 알림이 가요. */
export function InquiryInbox() {
  const actions = useActions();
  const { data, error } = useInquiries('/api/navi/inquiries/inbox');
  if (error) return <p className='lock-line'>{error}</p>;
  if (!data?.enabled) return null;
  const waiting = data.items.filter((i) => i.state !== 'done').length;
  return (
    <section className='card inquiry-box' aria-label='우리 팀에 온 문의'>
      <h2>우리 팀에 온 문의 {waiting > 0 && <span className='count'>{waiting}</span>}</h2>
      {data.items.length === 0 && <p className='empty'>아직 온 문의가 없어요.</p>}
      <ul className='plain inquiry-list'>
        {data.items.map((i) => (
          <li key={i.id}>
            <div className='inquiry-head'>
              <strong>{i.task}</strong>
              <StateBadge item={i} />
            </div>
            <p className='hint'>
              {i.sender ? `${i.sender.name} · ${i.sender.department}` : ''} · {when(i.createdAt)}
            </p>
            <p className='inquiry-text'>{i.question}</p>
            <p className='inquiry-reason'>사유: {i.reason}</p>
            {i.actions.length > 0 && (
              <div className='actions'>
                {i.actions.map((a) => (
                  <button key={a.text} type='button' className='secondary small' onClick={() => void actions.run(a)}>
                    {a.text}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 내 문의: 내가 보낸 문의와 처리 상태 */
export function MyInquiries() {
  const { data, error } = useInquiries('/api/navi/inquiries/mine');
  if (error) return <p className='lock-line'>{error}</p>;
  if (!data || data.items.length === 0) return null;
  return (
    <section className='card inquiry-box' aria-label='내 문의'>
      <h2>내 문의</h2>
      <ul className='plain inquiry-list'>
        {data.items.map((i) => (
          <li key={i.id}>
            <div className='inquiry-head'>
              <strong>
                {i.team} · {i.task}
              </strong>
              <StateBadge item={i} />
            </div>
            <p className='hint'>
              보낸 시각 {when(i.createdAt)}
              {i.state !== 'new' && ` · ${INQUIRY_STATE_LABEL[i.state]} ${when(i.updatedAt)}`}
            </p>
            <p className='inquiry-text'>{i.question}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
