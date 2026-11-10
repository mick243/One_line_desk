import {
  DEMO_GROUPWARE_BAND,
  DEMO_GROUPWARE_REASON_MAX,
  type GroupwareDecisionRequest,
  type GroupwareDoc,
  type GroupwareDraftRequest,
  type GroupwareFormResponse,
  type GroupwareInboxResponse,
  type GroupwareStep,
  LEAVE_KINDS,
  type LeaveDayChoice,
  type LeaveKind,
  reasonRequired,
} from '@one-line-desk/shared';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiFailure, apiRequest } from '../api';
import { newRequestId } from '../net';
import { GroupwareBoard } from './GroupwareBoard';
import './groupware-demo.css';

// 시연 전용 가상 그룹웨어 전자결재(11/6 사용자 결정, 휴가 A안). 한 줄 데스크가 아니라 "회사 그룹웨어" 자리에 서는 흉내예요.
// 시연에서 한 바퀴를 보여 줘요: 한 줄 데스크 신청 전 카드 [그룹웨어에서 신청하기] → 여기 휴가 신청서 [기안] → 결재함에서
// 팀장 결재 → 인사팀 결재 → 가상 근태 기록에 반영 → 한 줄 데스크가 근태 기록을 읽어 보여 줘요.
// - 다른 색·머리띠로 한 줄 데스크와 헷갈리지 않게 해요. 서버가 시연일 때만 이 주소와 API를 줘요(운영은 404).
// - 신청서 종류(연차·반차 오전/오후·병가·공가·경조)와 날은 주소의 날짜·종류 코드로 채워요(글 없음).
// - 사유는 병가·공가·경조면 꼭, 연차는 골라서 적어요. 사유는 가상 그룹웨어 메모리에만 있고 결재자·기안자만 봐요(한 줄 데스크로 가지 않아요).
// - 브라우저 저장소에 아무것도 넣지 않아요(R13). 문서는 서버 메모리에만 있어요.

/** 휴가 신청서 · 결재함 · 게시판(11/6 새 공지 알림 대상 시연, GroupwareBoard.tsx) */
export type GroupwarePage = 'leave' | 'inbox' | 'board';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HALF_LABEL: Record<LeaveDayChoice, string> = { full: '하루', am: '오전 반차', pm: '오후 반차' };
const STEP_LABEL: Record<GroupwareStep['state'], string> = { waiting: '대기', current: '결재 차례', approved: '승인', rejected: '반려' };
const NOT_DEMO = '가상 그룹웨어는 시연에서만 열려요';

/** 신청서 종류 칸: 연차·반차(오전)·반차(오후)·병가·공가·경조(11/6 사용자 결정) */
type FormKind = 'annual' | 'am' | 'pm' | 'sick' | 'official' | 'family-event';
const FORM_KINDS: { value: FormKind; label: string }[] = [
  { value: 'annual', label: '연차' },
  { value: 'am', label: '반차(오전)' },
  { value: 'pm', label: '반차(오후)' },
  { value: 'sick', label: '병가' },
  { value: 'official', label: '공가' },
  { value: 'family-event', label: '경조' },
];
const typeOfKind = (k: FormKind): LeaveKind => (k === 'am' || k === 'pm' ? 'annual' : k);

const failText = (e: unknown, fallback: string) => (e instanceof ApiFailure ? (e.status === 404 ? NOT_DEMO : e.message) : fallback);

/**
 * 주소의 자리 표시 값(한 줄 데스크 [그룹웨어에서 신청하기]가 채운 날짜·종류 코드)을 읽어요. 모양이 다르면 버려요.
 * 연차 반차인데 오전·오후를 모르면(half=half) 종류를 비워 두고 사람이 골라요.
 */
function prefillFromUrl(): { kind: FormKind | ''; part: LeaveDayChoice; from: string; to: string; filled: boolean } {
  const q = new URLSearchParams(window.location.search);
  const type: LeaveKind = (LEAVE_KINDS as readonly string[]).includes(q.get('type') ?? '') ? (q.get('type') as LeaveKind) : 'annual';
  const from = DATE.test(q.get('from') ?? '') ? q.get('from')! : '';
  const to = DATE.test(q.get('to') ?? '') ? q.get('to')! : from;
  const raw = q.get('half') ?? '';
  const half: LeaveDayChoice = raw === 'am' || raw === 'pm' ? raw : 'full';
  const kind: FormKind | '' = type !== 'annual' ? type : raw === 'half' ? '' : half === 'full' ? 'annual' : half;
  return { kind, part: type !== 'annual' ? half : 'full', from, to: to && to >= from ? to : from, filled: Boolean(from) };
}

export function GroupwareDemo({ page: first, onExit }: { page: GroupwarePage; onExit: () => void }) {
  const [page, setPage] = useState<GroupwarePage>(first);
  const go = useCallback((to: GroupwarePage) => {
    // 신청서 주소의 자리 표시 값은 한 번만 써요. 다른 화면으로 가면 주소에서 지워요.
    window.history.replaceState(null, '', `/demo/groupware/${to}`);
    setPage(to);
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className='gw'>
      <p className='gw-band' role='note'>
        {DEMO_GROUPWARE_BAND}
      </p>
      <header className='gw-head'>
        <strong className='gw-brand'>가상 그룹웨어 · 전자결재</strong>
        <nav className='gw-nav' aria-label='가상 그룹웨어 메뉴'>
          <button type='button' aria-current={page === 'leave' ? 'page' : undefined} onClick={() => go('leave')}>
            휴가 신청서
          </button>
          <button type='button' aria-current={page === 'inbox' ? 'page' : undefined} onClick={() => go('inbox')}>
            결재함
          </button>
          <button type='button' aria-current={page === 'board' ? 'page' : undefined} onClick={() => go('board')}>
            게시판
          </button>
        </nav>
      </header>
      <main className='gw-main'>{page === 'leave' ? <LeaveForm onDone={() => go('inbox')} /> : page === 'board' ? <GroupwareBoard /> : <Inbox />}</main>
      <footer className='gw-foot'>
        <p>
          {page === 'board'
            ? '한 줄 데스크는 이 게시판 공지를 공지 사본으로 가져가요. 제목·게시일·원문 링크와 찾기 색인만 저장하고, 본문은 저장하지 않아요.'
            : '한 줄 데스크는 이 문서를 읽지 않아요. 최종 승인돼 근태 기록에 들어간 휴가만 한 줄 데스크에 보여요.'}
        </p>
        <button type='button' className='gw-button' onClick={onExit}>
          한 줄 데스크로 돌아가기
        </button>
      </footer>
    </div>
  );
}

function LeaveForm({ onDone }: { onDone: () => void }) {
  const initial = useMemo(prefillFromUrl, []);
  const [form, setForm] = useState<GroupwareFormResponse | null>(null);
  const [kind, setKind] = useState<FormKind | ''>(initial.kind);
  const [part, setPart] = useState<LeaveDayChoice>(initial.part);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState<GroupwareDoc | null>(null);
  const requestId = useMemo(() => newRequestId(), []);

  useEffect(() => {
    let alive = true;
    apiRequest<GroupwareFormResponse>('GET', '/api/demo/groupware/form')
      .then((res) => {
        if (!alive) return;
        setForm(res);
        if (!initial.from) {
          setFrom(res.today);
          setTo(res.today);
        }
      })
      .catch((e: unknown) => alive && setMessage(failText(e, '신청서를 열지 못했어요')));
    return () => {
      alive = false;
    };
  }, [initial.from]);

  const halfDay = kind === 'am' || kind === 'pm';
  const until = halfDay ? from : to;
  const oneDay = from !== '' && from === until;
  // 연차 반차는 종류 칸에서, 병가·공가·경조의 반나절은 하루짜리일 때 아래에서 골라요. 여러 날은 하루씩이에요.
  const half: LeaveDayChoice = halfDay ? (kind as 'am' | 'pm') : kind !== 'annual' && oneDay ? part : 'full';
  const type = kind ? typeOfKind(kind) : null;
  const needReason = type !== null && reasonRequired(type);
  const ready = form !== null && type !== null && DATE.test(from) && DATE.test(until) && until >= from && (!needReason || reason.trim() !== '') && !busy;

  async function draft() {
    if (!ready || type === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const body: GroupwareDraftRequest = { type, from, to: until, half, requestId, ...(reason.trim() ? { reason: reason.trim() } : {}) };
      const res = await apiRequest<{ doc: GroupwareDoc }>('POST', '/api/demo/groupware/drafts', body);
      setSent(res.doc);
    } catch (e) {
      setMessage(failText(e, '기안하지 못했어요'));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <section className='gw-card' aria-label='기안한 문서'>
        <h1>기안했어요</h1>
        <DocView doc={sent} />
        <p className='gw-hint'>결재함에서 결재자로 보기를 바꿔 가며 팀장 → 인사팀 결재를 돌려 보세요.</p>
        <button type='button' className='gw-button gw-primary' onClick={onDone}>
          결재함 열기
        </button>
      </section>
    );
  }

  return (
    <section className='gw-card' aria-label='휴가 신청서'>
      <h1>휴가 신청서</h1>
      {initial.filled && <p className='gw-note'>한 줄 데스크에서 가져온 날짜·종류예요. 맞는지 보고 고쳐 주세요.</p>}
      {form && (
        <dl className='gw-fields'>
          <div>
            <dt>기안자</dt>
            <dd>
              {form.drafter.name} · {form.drafter.department}
            </dd>
          </div>
          <div>
            <dt>결재선</dt>
            <dd>{form.line.join(' → ')}</dd>
          </div>
        </dl>
      )}
      <label className='gw-label'>
        종류
        <select value={kind} onChange={(e) => setKind(e.target.value as FormKind)}>
          {kind === '' && <option value=''>반차는 오전·오후를 골라 주세요</option>}
          {FORM_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <div className='gw-row'>
        <label className='gw-label'>
          {halfDay ? '날짜' : '시작일'}
          <input
            type='date'
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              if (!to || to < e.target.value) setTo(e.target.value);
            }}
          />
        </label>
        {!halfDay && (
          <label className='gw-label'>
            끝날
            <input type='date' value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
        )}
      </div>
      {kind !== '' && kind !== 'annual' && !halfDay && oneDay && (
        <fieldset className='gw-choices'>
          <legend>하루 · 반나절</legend>
          {(['full', 'am', 'pm'] as const).map((c) => (
            <label key={c}>
              <input type='radio' name='gw-half' checked={part === c} onChange={() => setPart(c)} />
              {HALF_LABEL[c]}
            </label>
          ))}
        </fieldset>
      )}
      {!oneDay && !halfDay && <p className='gw-hint'>여러 날은 일하는 날을 하루씩 신청해요. {form?.offDays ?? '주말·공휴일·회사 휴일'}은 빼요.</p>}
      <label className='gw-label'>
        {needReason ? '사유(꼭 적어요)' : '사유(골라서 적어요)'}
        <textarea value={reason} maxLength={DEMO_GROUPWARE_REASON_MAX} rows={2} autoComplete='off' onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className='gw-hint'>
        사유는 결재자(팀장·인사팀)와 나만 봐요. 한 줄 데스크로는 가지 않아요. 시연에서는 다른 사람도 결재자로 들어와 볼 수 있어서 진짜 사유는 쓰지 마세요.
      </p>
      {message && (
        <p className='gw-error' role='alert'>
          {message}
        </p>
      )}
      <button type='button' className='gw-button gw-primary' disabled={!ready} onClick={() => void draft()}>
        {busy ? '기안하는 중' : '기안'}
      </button>
    </section>
  );
}

function Inbox() {
  const [as, setAs] = useState('');
  const [data, setData] = useState<GroupwareInboxResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (ref: string) => {
    try {
      const res = await apiRequest<GroupwareInboxResponse>('GET', `/api/demo/groupware/inbox${ref ? `?as=${encodeURIComponent(ref)}` : ''}`);
      setData(res);
      setMessage(null);
      // 결재자(팀장·인사팀)가 자기 계정으로 열면 서버가 자기 결재함을 줘요(11/10). 결재 버튼도 그 사람으로 보내요.
      if (!ref && res.as) setAs(res.as.ref);
    } catch (e) {
      setMessage(failText(e, '결재함을 열지 못했어요'));
    }
  }, []);
  useEffect(() => {
    void load(as);
  }, [as, load]);

  async function decide(doc: GroupwareDoc, decision: GroupwareDecisionRequest['decision'], reason?: string) {
    setDone(null);
    try {
      const body: GroupwareDecisionRequest = { as, decision, ...(reason ? { reason } : {}) };
      const res = await apiRequest<{ doc: GroupwareDoc }>('POST', `/api/demo/groupware/docs/${doc.id}/decision`, body);
      setDone(
        res.doc.state === 'rejected'
          ? `${res.doc.id}를 반려했어요. 기안자가 내 문서에서 사유를 봐요.`
          : res.doc.state === 'approved'
            ? res.doc.recorded
              ? `${res.doc.id}를 최종 승인했어요. 근태 기록에 들어가서 한 줄 데스크의 남은 연차·같은 팀 일정에 보여요.`
              : `${res.doc.id}를 최종 승인했어요. 근태 기록에는 넣지 못했어요.`
            : `${res.doc.id}를 승인했어요. 다음 결재자 차례예요.`,
      );
      await load(as);
    } catch (e) {
      setDone(failText(e, '결재하지 못했어요'));
    }
  }

  return (
    <>
      <section className='gw-card' aria-label='결재함'>
        <h1>결재함</h1>
        <label className='gw-label'>
          결재자로 보기
          <select value={as} onChange={(e) => setAs(e.target.value)}>
            <option value=''>결재자를 골라 주세요</option>
            {data?.approvers.map((a) => (
              <option key={a.ref} value={a.ref}>
                {a.name} · {a.department} {a.role === '팀장' ? '팀장' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className='gw-hint'>시연에서 결재를 한 화면으로 돌려 보는 장치예요. 실제 그룹웨어는 결재자가 자기 계정으로 봐요.</p>
        {message && (
          <p className='gw-error' role='alert'>
            {message}
          </p>
        )}
        {done && (
          <p className='gw-note' role='status'>
            {done}
          </p>
        )}
        {data?.as && data.waiting.length === 0 && <p className='gw-hint'>{data.as.name}님 결재 차례인 문서가 없어요.</p>}
        {data?.waiting.map((doc) => (
          <DocView key={doc.id} doc={doc}>
            <DecisionButtons onDecide={(d, r) => decide(doc, d, r)} />
          </DocView>
        ))}
      </section>
      <section className='gw-card' aria-label='내가 올린 문서'>
        <h2>내가 올린 문서</h2>
        {data && data.mine.length === 0 && <p className='gw-hint'>올린 문서가 없어요.</p>}
        {data?.mine.map((doc) => (
          <DocView key={doc.id} doc={doc} />
        ))}
      </section>
    </>
  );
}

function DecisionButtons({ onDecide }: { onDecide: (decision: GroupwareDecisionRequest['decision'], reason?: string) => Promise<void> }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (decision: GroupwareDecisionRequest['decision']) => {
    setBusy(true);
    try {
      await onDecide(decision, decision === 'rejected' ? reason.trim() : undefined);
    } finally {
      setBusy(false);
    }
  };
  if (rejecting) {
    return (
      <div className='gw-reject'>
        <label className='gw-label'>
          반려 사유(꼭 적어요)
          <textarea value={reason} maxLength={DEMO_GROUPWARE_REASON_MAX} rows={2} autoComplete='off' onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className='gw-hint'>시연에서는 다른 사람도 이 글을 봐요. 진짜 사유는 쓰지 마세요.</p>
        <div className='gw-actions'>
          <button type='button' className='gw-button gw-danger' disabled={busy || reason.trim() === ''} onClick={() => void run('rejected')}>
            반려하기
          </button>
          <button type='button' className='gw-button' disabled={busy} onClick={() => setRejecting(false)}>
            그만두기
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className='gw-actions'>
      <button type='button' className='gw-button gw-primary' disabled={busy} onClick={() => void run('approved')}>
        승인
      </button>
      <button type='button' className='gw-button' disabled={busy} onClick={() => setRejecting(true)}>
        반려
      </button>
    </div>
  );
}

export function DocView({ doc, children }: { doc: GroupwareDoc; children?: ReactNode }) {
  return (
    <article className={`gw-doc gw-doc-${doc.state}`} aria-label={`${doc.id} ${doc.typeLabel} 신청서`}>
      <header className='gw-doc-head'>
        <span className='gw-doc-id'>{doc.id}</span>
        <strong>{doc.typeLabel} 신청서</strong>
        <span className={`gw-state gw-state-${doc.state}`}>{doc.stateLabel}</span>
      </header>
      <dl className='gw-fields'>
        <div>
          <dt>기안자</dt>
          <dd>
            {doc.drafter.name} · {doc.drafter.department}
          </dd>
        </div>
        <div>
          <dt>쓸 날</dt>
          <dd>{doc.daysText}</dd>
        </div>
        <div>
          <dt>기안한 때</dt>
          <dd>{doc.createdAt}</dd>
        </div>
      </dl>
      <ol className='gw-line' aria-label='결재선'>
        {doc.line.map((s) => (
          <li key={s.label} className={`gw-step gw-step-${s.state}`}>
            {s.label} · {STEP_LABEL[s.state]}
            {s.by ? ` (${s.by} · ${s.at})` : ''}
          </li>
        ))}
      </ol>
      {doc.reason && <p className='gw-reason'>사유: {doc.reason}</p>}
      {doc.rejectReason && <p className='gw-error'>반려 사유: {doc.rejectReason}</p>}
      {doc.state === 'approved' && (
        <p className='gw-note'>{doc.recorded ? '근태 기록에 들어갔어요. 한 줄 데스크가 이 근태 기록을 읽어요.' : '근태 기록에 넣지 못했어요.'}</p>
      )}
      {children}
    </article>
  );
}
