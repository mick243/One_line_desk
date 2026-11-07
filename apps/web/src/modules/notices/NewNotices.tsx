import { NOTICE_AUDIENCE_TEXT, type NewNoticesResponse } from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../api';
import { useListVersion } from '../../components/ActionHost';

// 공지 탭 "새 공지"(11/6 새 공지 알림 대상, ADR-09 개정). 최근 7일 들어온 새 공지의 제목·게시일·원문 링크만 보여요(본문 없음).
// 알림은 공지 내용을 보고 고른 사람에게만 가지만, 공지는 여기서 누구나 봐요. 나에게 알림이 간 공지는 맨 위에 "나에게 해당할 수 있어요"를 붙여요.
// 알림("나에게 해당할 수 있는 새 공지가 있어요")을 누르면 이 페이지로 와요. 새 공지가 없으면 칸을 그리지 않아요.

export function NewNotices() {
  const { version, background } = useListVersion();
  const [data, setData] = useState<NewNoticesResponse | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<NewNoticesResponse>('GET', '/api/notices/new', undefined, { background: background() })
      .then((res) => alive && setData(res))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [version]);

  if (!data || data.items.length === 0) return null;
  return (
    <section className='card new-notices' aria-label={NOTICE_AUDIENCE_TEXT.newHead}>
      <h2>{NOTICE_AUDIENCE_TEXT.newHead}</h2>
      <ul className='plain new-notice-list'>
        {data.items.map((n) => (
          <li key={n.id} className={n.forMe ? 'for-me' : undefined}>
            {n.forMe && <span className='notice-for-me'>{NOTICE_AUDIENCE_TEXT.forMe}</span>}
            <a href={n.url} target='_blank' rel='noreferrer noopener'>
              {n.title}
            </a>
            <small>
              {n.board} · {n.postedOn}
            </small>
          </li>
        ))}
      </ul>
      <p className='hint'>{NOTICE_AUDIENCE_TEXT.newHint}</p>
    </section>
  );
}
