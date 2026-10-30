import { type CardAction, checkInput, INQUIRY_KEEP_DAYS, INQUIRY_QUESTION_MAX, INQUIRY_REASON_MAX, maskLine } from '@one-line-desk/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isDemoLogin } from '../../api';
import { useActions } from '../../components/ActionHost';
import { Sheet } from '../../components/Sheet';
import { newRequestId } from '../../net';

// 담당 팀에 문의 보내기 양식(ADR-16). 받는 곳은 분장표 행의 담당 팀이에요(담당자 이름은 없어요).
// [보내기] → 확인 시트(받는 곳·내 이름과 부서가 같이 간다는 것·보관 기간) → 보내요. 글은 보내기 전까지 이 화면 메모리에만 있어요.

type Inquire = Extract<CardAction, { type: 'inquire' }>;

function Field({
  label,
  value,
  onChange,
  max,
  rows,
  placeholder,
}: {
  label: string;
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
        {label}
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

export function InquirySheet({ action, initialQuestion, onClose }: { action: Inquire; initialQuestion: string; onClose: () => void }) {
  const actions = useActions();
  const [question, setQuestion] = useState(initialQuestion);
  const [reason, setReason] = useState('');
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
      body: { rowId: action.rowId, question: q.text, reason: r.text, requestId },
      confirm: {
        title: `${action.team}에 보낼까요?`,
        lines: [`업무: ${action.task}`, `받는 곳: ${action.team}(팀 창구)`, '내 이름과 부서가 같이 가요. 답을 받으려면 필요해요.'],
        confirmLabel: '보내기',
        note: `보낸 글은 ${action.team}이 읽고, ${INQUIRY_KEEP_DAYS}일 동안 보관돼요`,
      },
    });
  }

  return (
    <Sheet title={`${action.team}에 문의하기`} onClose={onClose}>
      <p className='inquiry-scope'>
        {action.team}에게 보내져요 · {action.task}
      </p>
      <Field
        label='문의 내용'
        value={question}
        onChange={setQuestion}
        max={INQUIRY_QUESTION_MAX}
        rows={4}
        placeholder='무엇이 궁금한지, 무엇을 해 달라는지 적어 주세요'
      />
      <Field label='사유' value={reason} onChange={setReason} max={INQUIRY_REASON_MAX} rows={2} placeholder='왜 필요한지 적어 주세요(예: 은행 제출용)' />
      <p className='hint'>키·비밀번호·주민번호·건강 정보는 적지 말아 주세요. 적으면 보낼 수 없어요.</p>
      {isDemoLogin() && <p className='demo-warning'>시연에서는 받는 팀 가상 직원으로 들어온 다른 사람도 이 글을 봐요. 진짜 고민은 쓰지 마세요</p>}
      <button type='button' className='primary' disabled={blocked} onClick={send}>
        보내기
      </button>
    </Sheet>
  );
}
