import {
  checkInput,
  INQUIRY_REPLY_MAX,
  INQUIRY_STATE_LABEL,
  type InquiryItem,
  type InquiryListResponse,
  LEAVE_REJECT_REASON_MAX,
  type LeaveDay,
  type LeaveRequestBalance,
  maskLine,
} from '@one-line-desk/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import { newRequestId } from '../../net';

// 받은 문의함(내 부서로 온 문의)과 내 문의(내가 보낸 문의). 담당 찾기 페이지 아래에 있어요(ADR-16).
// 10/30(ADR-24): 받은 팀은 답장을 보내고, 휴가 요청은 [승인]·[반려](사유 필수)해요. 결정 전 휴가 요청에는 보낸 사람 남은 연차가
// 서버 계산으로 같이 와요(그 요청 안에서만). 보낸 사람은 내 문의에서 답장·반려 사유·승인 결과를 봐요.

function when(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 ${iso.slice(11, 16)}`;
}
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일(${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
const fmt = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}일`;
const daysText = (days: readonly LeaveDay[]) => days.map((d) => `${dayLabel(d.date)} ${d.kind === 'full' ? '하루' : '반차'}`).join(' · ');

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

/** 글 칸 하나(공통 입력 검사). 걸리는 글자가 있으면 보낼 수 없어요(ADR-11). */
function TextBox({
  label,
  value,
  onChange,
  max,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  placeholder: string;
}) {
  const result = useMemo(() => checkInput(value), [value]);
  const line = maskLine(result);
  return (
    <label className='inquiry-field'>
      <span className='inquiry-label'>
        {label}
        <small>
          {value.length} / {max}
        </small>
      </span>
      <textarea value={value} maxLength={max} rows={2} placeholder={placeholder} autoComplete='off' onChange={(e) => onChange(e.target.value)} />
      {result.locks.map((l) => (
        <span key={l.kind} className='lock-line'>
          {l.message}
        </span>
      ))}
      {line && <span className='hint'>{line}</span>}
    </label>
  );
}

function Replies({ item }: { item: InquiryItem }) {
  if (!item.replies.length) return null;
  return (
    <ul className='plain inquiry-replies' aria-label='답장'>
      {item.replies.map((r, i) => (
        <li key={i}>
          <p className='hint'>
            {item.team} {r.name} · {when(r.at)}
          </p>
          <p className='inquiry-text'>{r.text}</p>
        </li>
      ))}
    </ul>
  );
}

/** 휴가 요청 칸: 쓸 날, (받은 팀·결정 전) 보낸 사람 남은 연차와 승인하면 남는 연차 */
const leftText = (after: number) => (after >= 0 ? `${fmt(after)} 남아요` : `${fmt(-after)} 모자라요`);

/**
 * 연차 기간별 줄(10/30). 요청한 날이 다음 연차 기간(입사일 기준)이면 이번 기간 연차는 그대로이고 다음 기간 연차에서 빠져요.
 * 기간을 말하지 않으면 "7.5일 → 7.5일"처럼 이유 없이 그대로인 것처럼 보여요.
 */
function balanceLines(b: LeaveRequestBalance): { text: string; short: boolean }[] {
  const lines: { text: string; short: boolean }[] = [];
  const thisEnd = `이번 연차 기간(${dayLabel(b.periodEnd)}까지)`;
  if (b.days > 0 || !b.next) lines.push({ text: `${thisEnd} 남은 ${fmt(b.remaining)} → 승인하면 ${leftText(b.after)}`, short: b.after < 0 });
  else lines.push({ text: `${thisEnd} 남은 ${fmt(b.remaining)} · 이 요청으로는 빠지지 않아요`, short: false });
  if (b.next) {
    lines.push({
      text: `다음 연차 기간(${dayLabel(b.next.periodStart)}부터) 남은 ${fmt(b.next.remaining)} → 승인하면 ${leftText(b.next.after)}`,
      short: b.next.after < 0,
    });
  }
  return lines;
}

/** 승인 확인 시트 한 줄: 어느 기간 연차가 얼마에서 얼마로 줄어드는지 */
function approveLine(b: LeaveRequestBalance): string {
  const parts = [
    ...(b.days > 0 ? [`이번 기간 남은 연차가 ${fmt(b.remaining)}에서 ${fmt(b.after)}로`] : []),
    ...(b.next ? [`다음 기간(${dayLabel(b.next.periodStart)}부터) 남은 연차가 ${fmt(b.next.remaining)}에서 ${fmt(b.next.after)}로`] : []),
  ];
  return `승인하면 근태 기록에 들어가 ${parts.join(', ')} 줄어요.`;
}

function LeaveBlock({ item }: { item: InquiryItem }) {
  const leave = item.leave;
  if (!leave) return null;
  const b = leave.balance;
  return (
    <div className='leave-block'>
      <p>
        <strong>쓸 날</strong> {daysText(leave.days)} · 연차 {fmt(leave.total)}
      </p>
      {b &&
        balanceLines(b).map((line, i) => (
          <p key={i} className={line.short ? 'leave-after short' : 'leave-after'}>
            {line.text}
          </p>
        ))}
      {b && <p className='hint'>근태 기록으로 서버가 계산 · 이 요청 처리에만 보여요</p>}
      {b === null && <p className='hint'>근태 기록에서 남은 연차를 찾지 못했어요. 그룹웨어 근태에서 확인해 주세요.</p>}
    </div>
  );
}

/** 받은 문의함 한 줄: 답장, 휴가 요청 승인·반려 */
function InboxItem({ item }: { item: InquiryItem }) {
  const actions = useActions();
  const [mode, setMode] = useState<'none' | 'reply' | 'reject'>('none');
  const [text, setText] = useState('');
  const requestId = useMemo(() => newRequestId(), [mode]);
  // 내 쓰기가 끝나면(목록이 새로 오면) 양식을 닫아요.
  useEffect(() => {
    setMode('none');
    setText('');
  }, [actions.writes]);

  const checked = checkInput(text.trim());
  const ready = Boolean(checked.text) && checked.locks.length === 0;
  const sender = item.sender ? `${item.sender.name}(${item.sender.department})` : '보낸 사람';

  function approve() {
    const b = item.leave?.balance;
    void actions.run({
      type: 'fixed',
      text: '승인',
      method: 'POST',
      path: `/api/navi/inquiries/${item.id}/decision`,
      body: { decision: 'approved' },
      confirm: {
        title: '휴가 요청을 승인할까요?',
        lines: [
          `${sender} · ${daysText(item.leave!.days)} · 연차 ${fmt(item.leave!.total)}`,
          b ? approveLine(b) : '근태 기록에 들어가 남은 연차에서 빠져요.',
          '보낸 사람에게 승인 알림이 가요.',
        ],
        confirmLabel: '승인',
      },
    });
  }

  function reject() {
    if (!ready) return;
    void actions.run({
      type: 'fixed',
      text: '반려',
      method: 'POST',
      path: `/api/navi/inquiries/${item.id}/decision`,
      body: { decision: 'rejected', reason: checked.text },
      confirm: {
        title: '휴가 요청을 반려할까요?',
        lines: [`${sender} · ${daysText(item.leave!.days)}`, `반려 사유: ${checked.text}`, '보낸 사람이 내 문의에서 사유를 봐요. 남은 연차는 그대로예요.'],
        confirmLabel: '반려',
      },
    });
  }

  function reply() {
    if (!ready) return;
    void actions.run({
      type: 'fixed',
      text: '답장 보내기',
      method: 'POST',
      path: `/api/navi/inquiries/${item.id}/reply`,
      body: { text: checked.text, requestId },
    });
  }

  return (
    <li>
      <div className='inquiry-head'>
        <strong>
          {item.kind === 'leave' && <span className='inquiry-kind'>휴가</span>}
          {item.task}
        </strong>
        <StateBadge item={item} />
      </div>
      <p className='hint'>
        {item.sender ? `${item.sender.name} · ${item.sender.department}` : ''} · {when(item.createdAt)}
      </p>
      {item.kind === 'leave' ? <LeaveBlock item={item} /> : <p className='inquiry-text'>{item.question}</p>}
      <p className='inquiry-reason'>사유: {item.reason}</p>
      {item.decisionReason && <p className='inquiry-reason'>반려 사유: {item.decisionReason}</p>}
      {item.state === 'approved' && item.recorded === false && (
        <p className='lock-line'>근태 연결이 안 돼서 남은 연차에서 빼지 못했어요. 그룹웨어 근태에 직접 반영해 주세요.</p>
      )}
      <Replies item={item} />

      {mode === 'reply' && <TextBox label='답장' value={text} onChange={setText} max={INQUIRY_REPLY_MAX} placeholder='보낸 사람에게 보낼 답을 적어 주세요' />}
      {mode === 'reject' && (
        <TextBox
          label='반려 사유(꼭 적어요)'
          value={text}
          onChange={setText}
          max={LEAVE_REJECT_REASON_MAX}
          placeholder='예) 그 주는 결산 마감이에요. 다음 주로 다시 신청해 주세요'
        />
      )}
      <div className='actions'>
        {mode === 'none' && (
          <>
            {item.canDecide && (
              <>
                <button type='button' className='primary small' onClick={approve}>
                  승인
                </button>
                <button type='button' className='secondary small' onClick={() => setMode('reject')}>
                  반려
                </button>
              </>
            )}
            {item.actions.map((a) => (
              <button key={a.text} type='button' className='secondary small' onClick={() => void actions.run(a)}>
                {a.text}
              </button>
            ))}
            {item.canReply && (
              <button type='button' className='link' onClick={() => setMode('reply')}>
                답장하기
              </button>
            )}
          </>
        )}
        {mode !== 'none' && (
          <>
            <button type='button' className='primary small' disabled={!ready} onClick={mode === 'reply' ? reply : reject}>
              {mode === 'reply' ? '답장 보내기' : '반려하기'}
            </button>
            <button
              type='button'
              className='link'
              onClick={() => {
                setMode('none');
                setText('');
              }}
            >
              그만두기
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** 받은 문의함: 분장표에 행이 있는 부서만 보여요. [확인했어요]·[처리했어요]·답장·(휴가) 승인·반려를 하면 보낸 사람에게 알림이 가요. */
export function InquiryInbox() {
  const { data, error } = useInquiries('/api/navi/inquiries/inbox');
  if (error) return <p className='lock-line'>{error}</p>;
  if (!data?.enabled) return null;
  const waiting = data.items.filter((i) => i.state === 'new' || i.state === 'seen').length;
  return (
    <section className='card inquiry-box' aria-label='우리 팀에 온 문의'>
      <h2>우리 팀에 온 문의 {waiting > 0 && <span className='count'>{waiting}</span>}</h2>
      {data.items.length === 0 && <p className='empty'>아직 온 문의가 없어요.</p>}
      <ul className='plain inquiry-list'>
        {data.items.map((i) => (
          <InboxItem key={i.id} item={i} />
        ))}
      </ul>
    </section>
  );
}

/** 내 문의: 내가 보낸 문의와 처리 상태·답장·반려 사유 */
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
                {i.kind === 'leave' && <span className='inquiry-kind'>휴가</span>}
                {i.team} · {i.task}
              </strong>
              <StateBadge item={i} />
            </div>
            <p className='hint'>
              보낸 시각 {when(i.createdAt)}
              {i.state !== 'new' && ` · ${INQUIRY_STATE_LABEL[i.state]} ${when(i.updatedAt)}`}
            </p>
            {i.kind === 'leave' ? <LeaveBlock item={i} /> : <p className='inquiry-text'>{i.question}</p>}
            {i.decisionReason && <p className='inquiry-reason'>반려 사유: {i.decisionReason}</p>}
            {i.state === 'approved' && (
              <p className='hint'>{i.recorded ? '근태 기록에 들어가 남은 연차에서 빠졌어요.' : '인사팀이 그룹웨어 근태에 반영해요.'}</p>
            )}
            <Replies item={i} />
          </li>
        ))}
      </ul>
    </section>
  );
}
