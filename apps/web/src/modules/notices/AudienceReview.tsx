import {
  NOTICE_AUDIENCE_ROLE_LABEL,
  NOTICE_AUDIENCE_TEXT,
  type NoticeAudience,
  type NoticeAudienceCountResponse,
  type NoticeAudienceItem,
  type NoticeAudienceListResponse,
  type NoticeAudienceRole,
} from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions, useListVersion } from '../../components/ActionHost';

// 새 공지 알림 대상 확인(11/6 사용자 요청, ADR-09 개정·ADR-16 보강). 총무(역할 facilities)에게만 보여요(서버도 403).
// AI가 공지 글만 보고 제안한 대상(부서·층·역할 칩)과 서버가 센 대상 수만 보여요. 대상자 이름 목록은 보이지 않아요.
// [알리기]는 확인 시트 뒤 고정 버튼이에요(두 번 눌러도 한 번). [대상 바꾸기]로 칩을 고치면 수를 다시 세요. [알리지 않기]는 알림 없이 끝내요.

type Options = NoticeAudienceListResponse['options'];

const STATE_TEXT: Record<NoticeAudienceItem['state'], string> = { pending: '확인 대기', sent: '알렸어요', skipped: '알리지 않았어요' };

/** "개발팀 · 5층 · 팀장" 또는 "모두" */
export function audienceText(a: NoticeAudience): string {
  if (a.everyone) return '모두';
  return [...a.departments, ...a.floors, ...a.roles.map((r) => NOTICE_AUDIENCE_ROLE_LABEL[r])].join(' · ');
}

const isEmpty = (a: NoticeAudience) => !a.everyone && !a.departments.length && !a.floors.length && !a.roles.length;
const same = (a: NoticeAudience, b: NoticeAudience) => JSON.stringify(a) === JSON.stringify(b);
const toggle = <T,>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

export function NoticeAudienceReview() {
  const { version, background } = useListVersion();
  const [data, setData] = useState<NoticeAudienceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiRequest<NoticeAudienceListResponse>('GET', '/api/notices/audience', undefined, { background: background() })
      .then((res) => alive && (setData(res), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof ApiFailure ? e.message : '알림 대상을 불러오지 못했어요'));
    return () => {
      alive = false;
    };
  }, [version]);

  if (error)
    return (
      <section className='card audience-review' aria-label={NOTICE_AUDIENCE_TEXT.reviewHead}>
        <h2>{NOTICE_AUDIENCE_TEXT.reviewHead}</h2>
        <p className='hint'>{error}</p>
      </section>
    );
  if (!data || data.items.length === 0) return null;
  const pending = data.items.filter((i) => i.state === 'pending');
  const done = data.items.filter((i) => i.state !== 'pending');
  return (
    <section className='card audience-review' aria-label={NOTICE_AUDIENCE_TEXT.reviewHead}>
      <h2>{NOTICE_AUDIENCE_TEXT.reviewHead}</h2>
      <p className='hint'>{NOTICE_AUDIENCE_TEXT.reviewHint}</p>
      {data.autoSend && <p className='hint'>자동 보내기가 켜져 있어요. 새 공지는 확인 없이 AI가 제안한 대상자에게 바로 알림이 가요.</p>}
      {pending.length === 0 && <p className='empty'>확인할 새 공지가 없어요.</p>}
      {pending.map((item) => (
        <ReviewItem key={item.id} item={item} options={data.options} />
      ))}
      {done.length > 0 && (
        <details className='audience-done'>
          <summary>처리한 공지 {done.length}건</summary>
          <ul className='plain'>
            {done.map((item) => (
              <li key={item.id}>
                <strong>{item.notice.title}</strong>
                <small>
                  {STATE_TEXT[item.state]}
                  {item.state === 'sent' && ` · ${audienceText(item.audience)} ${item.count}명`}
                  {item.auto && ' · 자동 보내기'}
                  {item.decidedAt && ` · ${item.decidedAt}`}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function ReviewItem({ item, options }: { item: NoticeAudienceItem; options: Options }) {
  const actions = useActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NoticeAudience>(item.audience);
  const [count, setCount] = useState<number | null>(item.count);
  const [countError, setCountError] = useState<string | null>(null);

  // 내 쓰기가 끝나면 고치던 칩을 처음 제안으로 돌려요. 새 알림으로 목록만 다시 부를 때는 고치던 칩을 그대로 둬요(10/29 개선 회의 A2).
  useEffect(() => {
    setEditing(false);
    setDraft(item.audience);
    setCount(item.count);
    setCountError(null);
  }, [actions.writes]);

  // 칩을 고치면 서버가 대상 수만 다시 세요(이름은 오지 않아요).
  useEffect(() => {
    if (!editing) return;
    if (isEmpty(draft)) {
      setCount(null);
      setCountError('알릴 대상을 하나 이상 골라 주세요');
      return;
    }
    let alive = true;
    apiRequest<NoticeAudienceCountResponse>('POST', '/api/notices/audience/count', { audience: draft })
      .then((res) => alive && (setCount(res.count), setCountError(null)))
      .catch((e: unknown) => alive && (setCount(null), setCountError(e instanceof ApiFailure ? e.message : '대상 수를 세지 못했어요')));
    return () => {
      alive = false;
    };
  }, [draft, editing]);

  const changed = !same(draft, item.audience);
  const ready = count !== null && count > 0 && !countError;

  function send() {
    if (!ready) return;
    void actions.run({
      type: 'fixed',
      text: '알리기',
      method: 'POST',
      path: `/api/notices/audience/${item.id}/send`,
      body: changed ? { audience: draft } : {},
      confirm: {
        title: NOTICE_AUDIENCE_TEXT.sendTitle,
        lines: [`공지: ${item.notice.title}`, `대상: ${audienceText(draft)} · ${count}명`, NOTICE_AUDIENCE_TEXT.sendLine, NOTICE_AUDIENCE_TEXT.sendKeep],
        confirmLabel: '알리기',
      },
    });
  }

  function skip() {
    void actions.run({
      type: 'fixed',
      text: '알리지 않기',
      method: 'POST',
      path: `/api/notices/audience/${item.id}/skip`,
      confirm: { title: NOTICE_AUDIENCE_TEXT.skipTitle, lines: [`공지: ${item.notice.title}`, NOTICE_AUDIENCE_TEXT.skipLine], confirmLabel: '알리지 않기' },
    });
  }

  const set = (next: Partial<NoticeAudience>) => setDraft((d) => ({ ...d, ...next, everyone: next.everyone ?? false }));

  return (
    <article className='result-card label-제안 audience-item' aria-label={`공지 제안 ${item.notice.title}`}>
      <header className='card-head'>
        <span className='kind'>공지</span>
        <span className='label'>제안</span>
      </header>
      <div className='card-body'>
        <p className='headline'>{item.notice.title}</p>
        <dl>
          <div className='field'>
            <dt>게시일</dt>
            <dd>
              {item.notice.postedOn} · {item.notice.board}
            </dd>
          </div>
          <div className='field'>
            <dt>알릴 대상</dt>
            <dd>
              {editing ? (
                <AudienceChips
                  draft={draft}
                  options={options}
                  onEveryone={() => setDraft({ everyone: true, departments: [], floors: [], roles: [] })}
                  onSet={set}
                />
              ) : (
                <span className='chips audience-chips'>
                  {item.audience.everyone ? (
                    <span className='chip selected'>모두</span>
                  ) : (
                    [...item.audience.departments, ...item.audience.floors, ...item.audience.roles.map((r) => NOTICE_AUDIENCE_ROLE_LABEL[r])].map((x) => (
                      <span key={x} className='chip selected'>
                        {x}
                      </span>
                    ))
                  )}
                </span>
              )}
            </dd>
          </div>
          <div className='field'>
            <dt>대상 수</dt>
            <dd>{count !== null ? `${count}명 · 이름은 보이지 않아요` : (countError ?? '세는 중이에요')}</dd>
          </div>
          <div className='field'>
            <dt>이유</dt>
            <dd>{item.evidence.length ? `공지에 나온 말: ${item.evidence.map((w) => `“${w}”`).join(' · ')}` : NOTICE_AUDIENCE_TEXT.noEvidence}</dd>
          </div>
        </dl>
      </div>
      <p className='evidence'>
        {item.byModel && <span className='ai-badge'>AI 정리</span>}
        <a href={item.notice.url} target='_blank' rel='noreferrer noopener'>
          공지 원문 열기
        </a>
      </p>
      <div className='card-actions'>
        <button type='button' className='primary' disabled={!ready} onClick={send}>
          알리기
        </button>
        <button
          type='button'
          className='secondary'
          onClick={() => (editing ? (setEditing(false), setDraft(item.audience), setCount(item.count), setCountError(null)) : setEditing(true))}
        >
          {editing ? '제안대로 돌리기' : '대상 바꾸기'}
        </button>
        <button type='button' className='secondary' onClick={skip}>
          알리지 않기
        </button>
      </div>
      <p className='tail'>알림에는 공지 제목·내용이 들어가지 않아요 · 대상이 아닌 사람도 공지 탭에서 봐요</p>
    </article>
  );
}

function AudienceChips({
  draft,
  options,
  onEveryone,
  onSet,
}: {
  draft: NoticeAudience;
  options: Options;
  onEveryone: () => void;
  onSet: (next: Partial<NoticeAudience>) => void;
}) {
  const group = (label: string, items: { key: string; text: string; on: boolean; press: () => void }[]) =>
    items.length > 0 && (
      <div className='audience-group' role='group' aria-label={label}>
        <small>{label}</small>
        <div className='chips'>
          {items.map((i) => (
            <button key={i.key} type='button' className='chip toggle' aria-pressed={i.on} onClick={i.press}>
              {i.text}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <div className='audience-edit'>
      {group('모두', [{ key: 'everyone', text: '모두', on: draft.everyone, press: onEveryone }])}
      {group(
        '부서',
        options.departments.map((d) => ({
          key: d,
          text: d,
          on: draft.departments.includes(d),
          press: () => onSet({ departments: toggle(draft.departments, d) }),
        })),
      )}
      {group(
        '층',
        options.floors.map((f) => ({ key: f, text: f, on: draft.floors.includes(f), press: () => onSet({ floors: toggle(draft.floors, f) }) })),
      )}
      {group(
        '역할',
        options.roles.map((r) => ({
          key: r.code,
          text: r.label,
          on: draft.roles.includes(r.code),
          press: () => onSet({ roles: toggle<NoticeAudienceRole>(draft.roles, r.code) }),
        })),
      )}
      <p className='hint'>칸끼리는 "또는"이에요. 어느 하나에 맞으면 알림이 가요.</p>
    </div>
  );
}
