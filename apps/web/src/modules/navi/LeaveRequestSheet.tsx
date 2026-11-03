import {
  addDays,
  type CardAction,
  checkInput,
  INQUIRY_KEEP_DAYS,
  INQUIRY_REASON_MAX,
  kstDate,
  LEAVE_REQUEST_MAX_DAYS,
  LEAVE_TYPE_LABEL,
  LEAVE_TYPES,
  type LeaveDay,
  type LeaveType,
  maskLine,
  OFFICIAL_LEAVE_REASON_LABEL,
  OFFICIAL_LEAVE_REASONS,
  type OfficialLeaveReason,
  SICK_LEAVE_PAST_DAYS,
  SICK_LEAVE_REASON_LABEL,
  SICK_LEAVE_REASONS,
  SICK_NOTE_TEXT,
  type SickLeaveReason,
  sickUsageText,
} from '@one-line-desk/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isDemoLogin } from '../../api';
import { useActions } from '../../components/ActionHost';
import { Sheet } from '../../components/Sheet';
import { newRequestId } from '../../net';

// 휴가 신청 양식(10/30, ADR-24). 연차 카드의 [휴가 신청하기]로 열려요.
// 질문에서 읽은 날(규칙, 양은 AI도)이 미리 채워져 있고, 사람이 날·하루/반차를 고치고 사유를 적어요.
// [보내기] → 확인 시트(받는 곳·쓸 날·인사팀이 이 요청 안에서 내 남은 연차를 봐요·보관 기간) → 인사팀 받은 문의함으로 가요.
// 남은 연차는 서버가 계산해 카드로 준 내 숫자예요. 이 화면 메모리에만 있어요.
// 11/1 공가: 맨 위에서 연차·공가를 골라요. 공가는 정해진 사유를 하나 고르고, 연차에서 빠지지 않아 남은 연차 계산을 보여 주지 않아요.
// 11/3 병가: 사유는 정해진 선택지만 고르고 자유 글 사유 칸은 없어요(건강 정보를 받지 않아요). 지난 3일까지 고를 수 있어요.
//   올해 병가 쓴 날(한도가 있으면 한도도)을 보여 주고, 운영 값 일수를 넘으면 진단서 안내를 보여 줘요. 유급·무급은 인사팀이 처리해요.

type LeaveRequest = Extract<CardAction, { type: 'leave-request' }>;

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const dayLabel = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일(${WEEKDAYS[weekday(date)]})`;
const fmt = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}일`;
const total = (days: readonly LeaveDay[]) => days.reduce((n, d) => n + (d.kind === 'full' ? 1 : 0.5), 0);

const DEFAULT_SICK_NOTE_OVER = 3;

/** 다음 평일(주말은 건너뛰어요) */
function nextWeekday(after: string): string {
  let d = addDays(after, 1);
  while ([0, 6].includes(weekday(d))) d = addDays(d, 1);
  return d;
}

export function LeaveRequestSheet({ action, onClose }: { action: LeaveRequest; onClose: () => void }) {
  const actions = useActions();
  const today = useMemo(() => kstDate(Date.now()), []);
  const [days, setDays] = useState<LeaveDay[]>(() => (action.days.length ? action.days.map((d) => ({ ...d })) : [{ date: nextWeekday(today), kind: 'full' }]));
  const [reason, setReason] = useState('');
  const [type, setType] = useState<LeaveType>(action.leaveType ?? 'annual');
  const [officialReason, setOfficialReason] = useState<OfficialLeaveReason | null>(null);
  const [sickReason, setSickReason] = useState<SickLeaveReason | null>(null);
  const official = type === 'official';
  const sick = type === 'sick';
  // 병가는 지난 3일까지 받아요. 연차·공가는 오늘부터예요.
  const earliest = sick ? addDays(today, -SICK_LEAVE_PAST_DAYS) : today;
  // 같은 양식에서 두 번 눌러도 한 번만 보내요(서버 멱등 키).
  const requestId = useMemo(() => newRequestId(), []);

  // 보내기가 끝나면(내 쓰기 횟수가 오르면) 양식을 닫아요.
  const startWrites = useRef(actions.writes);
  useEffect(() => {
    if (actions.writes !== startWrites.current) onClose();
  }, [actions.writes, onClose]);

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const problems = [
    ...sorted.filter((d) => !d.date).map(() => '날짜를 골라 주세요'),
    ...sorted
      .filter((d) => d.date && d.date < earliest)
      .map((d) => `${dayLabel(d.date)}은 지난 날이에요${sick ? `. 병가는 ${SICK_LEAVE_PAST_DAYS}일 전까지만 신청할 수 있어요` : ''}`),
    ...sorted.filter((d) => d.date && [0, 6].includes(weekday(d.date))).map((d) => `${dayLabel(d.date)}은 주말이에요`),
    ...sorted.filter((d, i) => d.date && sorted.findIndex((x) => x.date === d.date) !== i).map((d) => `${dayLabel(d.date)}을 두 번 골랐어요`),
  ];
  const sum = total(sorted);
  // 연차 기간(입사일 기준)별로 나눠요. 다음 기간 날은 이번 기간 연차가 아니라 다음 기간 연차에서 빠져요(10/30).
  const thisSum = total(sorted.filter((d) => d.date && d.date <= action.periodEnd));
  const nextSum = total(sorted.filter((d) => d.date > action.periodEnd));
  const after = action.remaining - thisSum;
  const nextAfter = action.next.remaining - nextSum;
  const left = (n: number) => (n >= 0 ? `${fmt(n)} 남아요` : `${fmt(-n)} 모자라요`);
  const r = checkInput(reason.trim());
  const line = maskLine(r);
  const noteOver = action.sick?.noteOverDays ?? DEFAULT_SICK_NOTE_OVER;
  const sickNote = sick && sum > noteOver;
  const sickAfter = action.sick ? action.sick.used + sum : null;
  const blocked = problems.length > 0 || !sorted.length || (sick ? !sickReason : !r.text || r.locks.length > 0) || (official && !officialReason);
  const summary = sorted.map((d) => `${dayLabel(d.date)} ${d.kind === 'full' ? '하루' : '반차'}`).join(' · ');

  const update = (i: number, patch: Partial<LeaveDay>) => setDays((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  function send() {
    if (blocked) return;
    if (sick && sickReason) return sendSick(sickReason);
    void actions.run({
      type: 'fixed',
      text: '보내기',
      method: 'POST',
      path: '/api/navi/inquiries',
      body: {
        rowId: action.rowId,
        question: `${LEAVE_TYPE_LABEL[type]} 신청`,
        reason: r.text,
        requestId,
        leave: official && officialReason ? { days: sorted, type, officialReason } : { days: sorted },
      },
      confirm: {
        title: `${action.team}에 ${official ? '공가' : '휴가'} 요청을 보낼까요?`,
        lines: official
          ? [
              `쓸 날: ${summary} · 공가 ${fmt(sum)}`,
              `공가 사유: ${officialReason ? OFFICIAL_LEAVE_REASON_LABEL[officialReason] : ''}`,
              `받는 곳: ${action.team}(${action.task})`,
              '내 이름과 부서가 같이 가요. 승인되면 근태 기록에 공가로 들어가고, 연차에서는 빠지지 않아요.',
              '훈련 통지서 같은 증빙은 인사팀에 따로 내 주세요.',
            ]
          : [
              `쓸 날: ${summary} · 연차 ${fmt(sum)}`,
              `받는 곳: ${action.team}(${action.task})`,
              `${action.team}이 이 요청을 처리하는 동안 내 남은 연차를 함께 봐요.`,
              '내 이름과 부서가 같이 가요. 승인되면 근태 기록에 들어가 남은 연차에서 빠져요.',
            ],
        confirmLabel: '보내기',
        note: `보낸 요청과 사유는 ${action.team}이 읽고, ${INQUIRY_KEEP_DAYS}일 동안 보관돼요`,
      },
    });
  }

  /** 병가: 자유 글 사유(reason)는 보내지 않아요. 사유는 코드만 가요. */
  function sendSick(code: SickLeaveReason) {
    void actions.run({
      type: 'fixed',
      text: '보내기',
      method: 'POST',
      path: '/api/navi/inquiries',
      body: { rowId: action.rowId, question: '병가 신청', requestId, leave: { days: sorted, type: 'sick', sickReason: code } },
      confirm: {
        title: `${action.team}에 병가 요청을 보낼까요?`,
        lines: [
          `쓸 날: ${summary} · 병가 ${fmt(sum)}`,
          `병가 사유: ${SICK_LEAVE_REASON_LABEL[code]}`,
          `받는 곳: ${action.team}(${action.task})`,
          `${action.team}이 이 요청을 처리하는 동안 내 올해 병가 쓴 날을 함께 봐요.`,
          '내 이름과 부서가 같이 가요. 승인되면 근태 기록에 병가로 들어가고, 연차에서는 빠지지 않아요. 유급·무급은 인사팀이 처리해요.',
          ...(sickNote ? [`${SICK_NOTE_TEXT}.`] : []),
        ],
        confirmLabel: '보내기',
        note: `보낸 요청은 ${action.team}이 읽고, ${INQUIRY_KEEP_DAYS}일 동안 보관돼요`,
      },
    });
  }

  return (
    <Sheet title={official ? '공가 신청하기' : sick ? '병가 신청하기' : '휴가 신청하기'} onClose={onClose}>
      <p className='inquiry-scope'>
        {action.team}에 보내져요 · {action.task}
      </p>
      <div className='segmented leave-type' role='group' aria-label='휴가 종류'>
        {LEAVE_TYPES.map((t) => (
          <button key={t} type='button' aria-pressed={type === t} onClick={() => setType(t)}>
            {LEAVE_TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      {official ? (
        <>
          <p className='leave-remaining'>공가는 연차에서 빠지지 않아요.</p>
          <fieldset className='inquiry-field official-reasons'>
            <legend className='inquiry-label'>공가 사유(꼭 골라요)</legend>
            {OFFICIAL_LEAVE_REASONS.map((code) => (
              <label key={code} className='radio-line'>
                <input type='radio' name='official-reason' checked={officialReason === code} onChange={() => setOfficialReason(code)} />
                {OFFICIAL_LEAVE_REASON_LABEL[code]}
              </label>
            ))}
          </fieldset>
          <p className='hint'>훈련 통지서·출석 요구서 같은 증빙은 앱이 받지 않아요. 인사팀에 따로 내 주세요.</p>
        </>
      ) : sick ? (
        <>
          <p className='leave-remaining'>병가는 연차에서 빠지지 않아요. {action.sick ? <strong>{sickUsageText(action.sick)}</strong> : null}</p>
          <fieldset className='inquiry-field official-reasons'>
            <legend className='inquiry-label'>병가 사유(꼭 골라요)</legend>
            {SICK_LEAVE_REASONS.map((code) => (
              <label key={code} className='radio-line'>
                <input type='radio' name='sick-reason' checked={sickReason === code} onChange={() => setSickReason(code)} />
                {SICK_LEAVE_REASON_LABEL[code]}
              </label>
            ))}
          </fieldset>
          <p className='hint'>
            병명·증상은 적지 않아요. 오늘부터 {SICK_LEAVE_PAST_DAYS}일 전까지 신청할 수 있어요. {fmt(noteOver)}을 넘게 쉬면 진단서는 인사팀에 따로 내 주세요.
          </p>
        </>
      ) : (
        <p className='leave-remaining'>
          지금 남은 연차 <strong>{fmt(action.remaining)}</strong> <small className='hint'>· 이번 연차 기간 {dayLabel(action.periodEnd)}까지</small>
        </p>
      )}
      {action.planned !== undefined && !action.days.length && <p className='hint'>말씀하신 {fmt(action.planned)}만큼 날을 골라 주세요.</p>}
      {action.days.length > 0 && <p className='hint'>질문에서 읽은 날을 채워 두었어요. 맞는지 보고 고쳐 주세요.</p>}

      <ul className='plain leave-days' aria-label='쓸 날'>
        {days.map((d, i) => (
          <li key={i} className='leave-day'>
            <input
              type='date'
              aria-label={`${i + 1}번째 날`}
              value={d.date}
              min={earliest}
              max={addDays(today, 365)}
              onChange={(e) => update(i, { date: e.target.value })}
            />
            <div className='segmented' role='group' aria-label='하루 또는 반차'>
              {(['full', 'half'] as const).map((k) => (
                <button key={k} type='button' aria-pressed={d.kind === k} onClick={() => update(i, { kind: k })}>
                  {k === 'full' ? '하루' : '반차'}
                </button>
              ))}
            </div>
            <button
              type='button'
              className='link'
              aria-label={`${d.date ? dayLabel(d.date) : '이 날'} 빼기`}
              disabled={days.length === 1}
              onClick={() => setDays((list) => list.filter((_, j) => j !== i))}
            >
              빼기
            </button>
          </li>
        ))}
      </ul>
      {days.length < LEAVE_REQUEST_MAX_DAYS && (
        <button
          type='button'
          className='secondary small'
          onClick={() =>
            setDays((list) => [
              ...list,
              {
                date: nextWeekday(
                  list
                    .map((d) => d.date)
                    .sort()
                    .at(-1) || today,
                ),
                kind: 'full',
              },
            ])
          }
        >
          날 더하기
        </button>
      )}
      {problems.map((p) => (
        <p key={p} className='lock-line' role='alert'>
          {p}
        </p>
      ))}
      <div role='status'>
        {official && sum > 0 && <p className='leave-after'>공가 {fmt(sum)} · 남은 연차는 그대로예요</p>}
        {sick && sum > 0 && (
          <p className={`leave-after${action.sick?.limit && sickAfter !== null && sickAfter > action.sick.limit ? ' short' : ''}`}>
            병가 {fmt(sum)} · 남은 연차는 그대로예요
            {sickAfter !== null ? ` · 보내면 올해 병가 ${action.sick?.limit ? `${fmt(action.sick.limit)} 중 ` : ''}${fmt(sickAfter)}` : ''}
          </p>
        )}
        {sickNote && <p className='hint'>{SICK_NOTE_TEXT}. 유급·무급은 인사팀이 처리해요.</p>}
        {!official && !sick && (thisSum > 0 || nextSum === 0) && (
          <p className={`leave-after${after < 0 ? ' short' : ''}`}>
            {nextSum > 0 ? `이번 연차 기간(${dayLabel(action.periodEnd)}까지) ` : ''}연차 {fmt(thisSum)}을 쓰면 {left(after)}
          </p>
        )}
        {!official && !sick && nextSum > 0 && (
          <p className={`leave-after${nextAfter < 0 ? ' short' : ''}`}>
            다음 연차 기간({dayLabel(action.next.periodStart)}부터) 연차 {fmt(nextSum)}을 쓰면 {left(nextAfter)}
          </p>
        )}
        {!official && !sick && nextSum > 0 && thisSum === 0 && (
          <p className='hint'>고른 날이 다음 연차 기간이라 지금 남은 연차({fmt(action.remaining)})에서는 빠지지 않아요.</p>
        )}
      </div>

      {!sick && (
        <label className='inquiry-field'>
          <span className='inquiry-label'>
            사유
            <small>
              {reason.length} / {INQUIRY_REASON_MAX}
            </small>
          </span>
          <textarea
            value={reason}
            maxLength={INQUIRY_REASON_MAX}
            rows={2}
            placeholder={official ? '예) 예비군 2년 차 훈련' : '예) 가족 행사 · 개인 사정'}
            autoComplete='off'
            onChange={(e) => setReason(e.target.value)}
          />
          {r.locks.map((l) => (
            <span key={l.kind} className='lock-line'>
              {l.message}
            </span>
          ))}
          {line && <span className='hint'>{line}</span>}
        </label>
      )}
      {!sick && <p className='hint'>건강 정보·주민번호 같은 글은 적지 말아 주세요. 적으면 보낼 수 없어요.</p>}
      {isDemoLogin() && <p className='demo-warning'>시연에서는 인사팀 가상 직원으로 들어온 다른 사람도 이 요청을 봐요. 진짜 사유는 쓰지 마세요</p>}
      <button type='button' className='primary' disabled={blocked} onClick={send}>
        보내기
      </button>
    </Sheet>
  );
}
