import { type CardAction, checkInput, IT_HELP_TEXT_MAX, type ItHelpResponse, itInquiryDraft, maskLine } from '@one-line-desk/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { Icon } from '../../components/Icon';
import { InquirySheet } from './InquirySheet';
import './navi.css';

// IT 오류 문장 → IT FAQ 원문 단계(10/31 넓힐 후보 ②). 담당 찾기 탭 아래 화면이에요.
// - 붙여 넣은 글은 이 화면 메모리에만 있어요. 공통 입력 검사로 가린 글만 POST 본문으로 보내고, 서버도 저장하지 않아요.
// - FAQ 단계는 원문 그대로 번호 목록으로 보여요. AI가 쓰거나 고치지 않아요.
// - 해결이 안 되면 IT지원팀 문의 양식을 가린 글로 채워 열어요. 보내기는 사람이 확인 시트에서 눌러요. 복사 버튼은 없어요(10/31 사용자 결정).
// 11/3 QA 낮음: 못 찾았으면 후보 칩을 문의보다 먼저 보여 주고(L2), 칩으로 연 FAQ에서 찾은 결과로 돌아갈 수 있어요(L2).
//   글을 고치면 이전 결과를 지워요(L2). 찾는 동안에도 초점이 버튼에 남고, Ctrl+Enter로 찾아요(L4).

type Inquire = Extract<CardAction, { type: 'inquire' }>;

export function ItHelpScreen({ onBack }: { onBack: () => void }) {
  const [text, setText] = useState('');
  const [sentMasked, setSentMasked] = useState<string | null>(null);
  /** 붙여 넣은 글로 찾은 결과. 칩으로 다른 FAQ를 열어도 남아서 돌아갈 수 있어요. */
  const [found, setFound] = useState<ItHelpResponse | null>(null);
  /** 칩으로 연 다른 FAQ. 없으면 찾은 결과를 보여 줘요. */
  const [picked, setPicked] = useState<ItHelpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [inquiry, setInquiry] = useState<{ action: Inquire; question: string } | null>(null);
  const resultHead = useRef<HTMLParagraphElement>(null);
  const [focusResult, setFocusResult] = useState(false);
  const checked = useMemo(() => checkInput(text), [text]);
  const line = maskLine(checked);
  const locked = checked.locks.length > 0;
  const result = picked ?? found;

  // 칩으로 FAQ를 열거나 돌아오면 결과 제목으로 초점을 옮겨요. 누른 칩이 다시 그려져도 초점이 빠지지 않게요(L4).
  useEffect(() => {
    if (!focusResult || loading) return;
    resultHead.current?.focus();
    setFocusResult(false);
  }, [focusResult, loading, result]);

  function edit(next: string) {
    setText(next);
    // 글을 고치면 이전 결과는 이 글의 결과가 아니라서 지워요(L2).
    if (found || picked || error) {
      setFound(null);
      setPicked(null);
      setError(null);
      setSentMasked(null);
    }
  }

  async function find() {
    // 버튼을 잠그지 않고 여기서 막아요. 잠그면 키보드 초점이 빠져요(L4).
    if (locked || !text.trim() || loading) return;
    setLoading(true);
    setError(null);
    setFound(null);
    setPicked(null);
    try {
      setFound(await apiRequest<ItHelpResponse>('POST', '/api/navi/it-help', { text: checked.text }));
      setSentMasked(checked.text);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 찾지 못했어요');
    } finally {
      setLoading(false);
    }
  }

  async function open(id: string) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      setPicked(await apiRequest<ItHelpResponse>('POST', '/api/navi/it-help/faq', { id }));
      setFocusResult(true);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 열지 못했어요');
    } finally {
      setLoading(false);
    }
  }

  function backToFound() {
    setPicked(null);
    setError(null);
    setFocusResult(true);
  }

  function askIt(r: ItHelpResponse) {
    setInquiry({
      action: { type: 'inquire', text: `${r.inquiryTeam}에 문의하기`, rowId: r.inquiryRowId, team: r.inquiryTeam, task: r.inquiryTask },
      question: itInquiryDraft({ maskedText: sentMasked ?? checked.text, faqTitle: r.faq?.title }),
    });
  }

  // 후보 칩은 찾은 결과의 것을 늘 보여 줘요. 칩으로 연 FAQ는 칩에서 "보는 중"으로 표시해요.
  const others = found?.others ?? [];
  const chips = others.length > 0 && (
    <div className='it-others'>
      <p className='example-label'>{found?.faq ? '비슷한 다른 FAQ' : '이 중에 있나요?'}</p>
      <div className='chips'>
        {others.map((o) => (
          <button
            key={o.id}
            type='button'
            className={picked?.faq?.id === o.id ? 'chip selected' : 'chip'}
            aria-pressed={picked?.faq?.id === o.id}
            onClick={() => void open(o.id)}
          >
            {o.title}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className='feature-page it-help'>
      <button type='button' className='link back' onClick={onBack}>
        ← 문의하기
      </button>
      <header className='page-head'>
        <p className='eyebrow'>문의하기</p>
        <h1>IT 오류가 났나요?</h1>
        <p className='lead'>오류 창의 글을 붙여 넣으면 비슷한 IT FAQ의 해결 단계를 원문 그대로 보여 줘요.</p>
      </header>

      <form
        className='checked-input it-help-input'
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <div className='scope'>
          <Icon name='lock' size={14} />
          나만 보여요
        </div>
        <textarea
          value={text}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl+Enter(맥은 Cmd+Enter)로 찾아요. 그냥 Enter는 줄바꿈이에요(L4).
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void find();
            }
          }}
          placeholder='오류 창의 글을 그대로 붙여 넣어 주세요'
          aria-label='오류 창의 글'
          aria-describedby='it-help-keys'
          maxLength={IT_HELP_TEXT_MAX}
          rows={5}
          autoComplete='off'
          spellCheck={false}
        />
        <div className='it-help-foot'>
          <small className='hint it-help-count'>
            {text.length} / {IT_HELP_TEXT_MAX}
          </small>
          <small id='it-help-keys' className='hint it-help-keys'>
            Ctrl+Enter로도 찾아요
          </small>
          <button type='submit' aria-disabled={locked || !text.trim() || loading}>
            {loading ? '찾는 중' : '비슷한 오류 찾기'}
          </button>
        </div>
        {text.length >= IT_HELP_TEXT_MAX && <p className='hint'>{IT_HELP_TEXT_MAX}자를 넘친 뒷부분은 들어가지 않았어요</p>}
        {checked.locks.map((l) => (
          <p key={l.kind} className='lock-line'>
            {l.message}
          </p>
        ))}
        {line && <p className='hint'>{line}</p>}
      </form>

      <section className='results' aria-live='polite' aria-busy={loading}>
        {loading && <div className='skeleton' aria-label='찾는 중' />}
        {error && (
          <p className='lock-line' role='alert'>
            {error}
          </p>
        )}
        {picked && found && (
          <button type='button' className='link back' onClick={backToFound}>
            ← 찾은 결과로 돌아가기
          </button>
        )}
        {/* 못 찾았을 때는 후보 칩을 먼저 보여 줘요. 맞는 FAQ가 문의 버튼 아래에 묻히던 문제(L2). */}
        {found && !found.faq && !picked && chips}
        {result?.faq && (
          <article className='result-card label-안내' aria-label='담당 안내'>
            <header className='card-head'>
              <span className='kind'>담당</span>
              <span className='label'>안내</span>
            </header>
            <div className='card-body'>
              <p className='headline' ref={resultHead} tabIndex={-1}>
                {result.faq.title}
              </p>
              <ol className='it-steps'>
                {result.faq.steps.map((s, i) => (
                  <li key={`${i}-${s}`}>{s}</li>
                ))}
              </ol>
            </div>
            <p className='evidence'>
              IT FAQ "{result.faq.title}" · 개정일 {result.faq.revisedOn}
            </p>
            <div className='card-actions'>
              <button type='button' className='secondary' onClick={() => askIt(result)}>
                해결 안 됐어요 · {result.inquiryTeam}에 문의하기
              </button>
            </div>
            <p className='tail'>붙여 넣은 글은 저장하지 않아요</p>
          </article>
        )}
        {result && !result.faq && (
          <article className='result-card label-안내' aria-label='담당 안내'>
            <header className='card-head'>
              <span className='kind'>담당</span>
              <span className='label'>안내</span>
            </header>
            <div className='card-body'>
              <p className='headline' ref={resultHead} tabIndex={-1}>
                {others.length > 0
                  ? `위 FAQ에도 없으면 아래 버튼으로 ${result.inquiryTeam}에 알려 주세요`
                  : `비슷한 IT FAQ를 찾지 못했어요. 아래 버튼으로 ${result.inquiryTeam}에 알려 주세요`}
              </p>
            </div>
            <div className='card-actions'>
              <button type='button' className='secondary' onClick={() => askIt(result)}>
                {result.inquiryTeam}에 문의하기
              </button>
            </div>
            <p className='tail'>붙여 넣은 글은 저장하지 않아요</p>
          </article>
        )}
        {(found?.faq || picked) && chips}
      </section>

      {inquiry && (
        <InquirySheet
          action={inquiry.action}
          initialQuestion={inquiry.question}
          reasonPlaceholder='언제부터, 무엇을 못 하고 있는지 적어 주세요(예: 오늘 아침부터 메일을 못 보내요)'
          onClose={() => setInquiry(null)}
        />
      )}
    </div>
  );
}
