import {
  type CardAction,
  checkInput,
  INQUIRY_KEEP_DAYS,
  INQUIRY_QUESTION_MAX,
  INQUIRY_REASON_MAX,
  type InquiryRouteBy,
  type InquiryTarget,
  maskLine,
} from '@one-line-desk/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isDemoLogin } from '../../api';
import { useActions } from '../../components/ActionHost';
import { Sheet } from '../../components/Sheet';
import { newRequestId } from '../../net';

// 담당 팀에 문의 보내기 양식(ADR-16). 받는 곳은 분장표 행의 담당 팀이에요(담당자 이름은 없어요).
// [보내기] → 확인 시트(받는 곳·내 이름과 부서가 같이 간다는 것·보관 기간) → 보내요. 글은 보내기 전까지 이 화면 메모리에만 있어요.
// 11/2 문의하기(ADR-26): 서버가 받는 팀을 골랐으면(routed) 누가 골랐는지 보여 주고, 다른 후보로 바꿀 수 있어요. 보내기는 늘 사람이 눌러요.

type Inquire = Extract<CardAction, { type: 'inquire' }>;

function Field({
  label,
  value,
  onChange,
  max,
  rows,
  placeholder,
  required = false,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  max: number;
  rows: number;
  placeholder: string;
}) {
  const result = useMemo(() => checkInput(value), [value]);
  const line = maskLine(result);
  return (
    <label className='inquiry-field'>
      <span className='inquiry-label'>
        <span>
          {label}
          {required && <em className='required'> 꼭 적어 주세요</em>}
        </span>
        <small>
          {value.length} / {max}
        </small>
      </span>
      <textarea value={value} maxLength={max} rows={rows} placeholder={placeholder} autoComplete='off' onChange={(e) => onChange(e.target.value)} />
      {result.locks.map((l) => (
        <span key={l.kind} className='lock-line'>
          {l.message}
        </span>
      ))}
      {line && <span className='hint'>{line}</span>}
    </label>
  );
}

const ROUTE_LINE: Record<InquiryRouteBy, string> = {
  ai: 'AI가 문의 내용을 보고 업무 분장표에서 고른 곳이에요',
  rule: '업무 분장표에서 문의 내용과 맞는 업무로 고른 곳이에요',
  none: '분장표에서 맞는 팀을 못 찾아 대표 창구로 보내요',
};

/** 사유 예시는 문의 맥락에 맞춰 바꿔요. "은행 제출용"이 IT 오류·온보딩 문의에 맞지 않던 문제(11/1 QA M4). */
const DEFAULT_REASON_PLACEHOLDER = '왜 필요한지, 언제까지 필요한지 적어 주세요(예: 다음 주 출장 전에 필요해요)';

export function InquirySheet({
  action,
  initialQuestion,
  reasonPlaceholder = DEFAULT_REASON_PLACEHOLDER,
  onClose,
}: {
  action: Inquire;
  initialQuestion: string;
  reasonPlaceholder?: string;
  onClose: () => void;
}) {
  const actions = useActions();
  const [question, setQuestion] = useState(initialQuestion);
  const [reason, setReason] = useState('');
  // 받는 곳. 서버가 고른 곳에서 시작하고, 사람이 다른 후보로 바꿀 수 있어요.
  const [target, setTarget] = useState<InquiryTarget>({ rowId: action.rowId, team: action.team, task: action.task });
  const [changing, setChanging] = useState(false);
  const choices = action.routed
    ? [{ rowId: action.rowId, team: action.team, task: action.task }, ...action.routed.alternatives].filter(
        (t, i, list) => list.findIndex((x) => x.rowId === t.rowId) === i,
      )
    : [];
  const picked = target.rowId === action.rowId;
  // 같은 양식에서 두 번 눌러도 한 번만 보내요(서버 멱등 키).
  const requestId = useMemo(() => newRequestId(), []);

  // 보내기가 끝나면(내 쓰기 횟수가 오르면) 양식을 닫아요. 확인 시트에서 [닫기]를 누르거나 새 알림이 와도 쓴 글이 그대로 남아요.
  const startWrites = useRef(actions.writes);
  useEffect(() => {
    if (actions.writes !== startWrites.current) onClose();
  }, [actions.writes, onClose]);

  const q = checkInput(question.trim());
  const r = checkInput(reason.trim());
  const blocked = !q.text || !r.text || q.locks.length > 0 || r.locks.length > 0;

  function send() {
    if (blocked) return;
    void actions.run({
      type: 'fixed',
      text: '보내기',
      method: 'POST',
      path: '/api/navi/inquiries',
      body: { rowId: target.rowId, question: q.text, reason: r.text, requestId },
      confirm: {
        title: `${target.team}에 보낼까요?`,
        lines: [
          `업무: ${target.task}`,
          `받는 곳: ${target.team}(팀 창구)${action.routed ? (picked ? ` · ${action.routed.by === 'ai' ? 'AI가 고름' : action.routed.by === 'rule' ? '분장표로 고름' : '대표 창구'}` : ' · 내가 바꿈') : ''}`,
          '내 이름과 부서가 같이 가요. 답을 받으려면 필요해요.',
        ],
        confirmLabel: '보내기',
        note: `보낸 글은 ${target.team}이 읽고, ${INQUIRY_KEEP_DAYS}일 동안 보관돼요`,
      },
    });
  }

  return (
    <Sheet title={`${target.team}에 문의하기`} onClose={onClose}>
      <p className='inquiry-scope'>
        {target.team}에게 보내져요 · {target.task}
      </p>
      {action.routed && (
        <div className='route-box'>
          <p className='hint'>
            {picked ? ROUTE_LINE[action.routed.by] : '내가 고른 곳이에요'}
            {picked && action.routed.by === 'ai' && <span className='ai-badge'>AI 정리</span>}
          </p>
          {choices.length > 1 && !changing && (
            <button type='button' className='link' onClick={() => setChanging(true)}>
              받는 곳 바꾸기
            </button>
          )}
          {changing && (
            <div className='route-choices' role='group' aria-label='받는 곳 고르기'>
              {choices.map((t) => (
                <button
                  key={t.rowId ?? 'general'}
                  type='button'
                  className='chip'
                  aria-pressed={t.rowId === target.rowId}
                  onClick={() => {
                    setTarget(t);
                    setChanging(false);
                  }}
                >
                  {t.team} · {t.task}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Field
        label='문의 내용'
        value={question}
        onChange={setQuestion}
        max={INQUIRY_QUESTION_MAX}
        rows={4}
        placeholder='무엇이 궁금한지, 무엇을 해 달라는지 적어 주세요'
      />
      <Field label='사유' required value={reason} onChange={setReason} max={INQUIRY_REASON_MAX} rows={2} placeholder={reasonPlaceholder} />
      <p className='hint'>키·비밀번호·주민번호·건강 정보는 적지 말아 주세요. 적으면 보낼 수 없어요.</p>
      {isDemoLogin() && <p className='demo-warning'>시연에서는 받는 팀 가상 직원으로 들어온 다른 사람도 이 글을 봐요. 진짜 고민은 쓰지 마세요</p>}
      {(!q.text || !r.text) && <p className='hint send-hint'>{!q.text ? '문의 내용을' : '사유를'} 적으면 보낼 수 있어요</p>}
      <button type='button' className='primary' disabled={blocked} onClick={send}>
        보내기
      </button>
    </Sheet>
  );
}
