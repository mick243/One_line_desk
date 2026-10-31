import { type CardAction, checkInput, IT_HELP_TEXT_MAX, type ItHelpResponse, itInquiryDraft, maskLine } from '@one-line-desk/shared';
import { useMemo, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { Icon } from '../../components/Icon';
import { InquirySheet } from './InquirySheet';
import './navi.css';

// IT 오류 문장 → IT FAQ 원문 단계(10/31 넓힐 후보 ②). 담당 찾기 탭 아래 화면이에요.
// - 붙여 넣은 글은 이 화면 메모리에만 있어요. 공통 입력 검사로 가린 글만 POST 본문으로 보내고, 서버도 저장하지 않아요.
// - FAQ 단계는 원문 그대로 번호 목록으로 보여요. AI가 쓰거나 고치지 않아요.
// - 해결이 안 되면 IT지원팀 문의 양식을 가린 글로 채워 열어요. 보내기는 사람이 확인 시트에서 눌러요. 복사 버튼은 없어요(10/31 사용자 결정).

type Inquire = Extract<CardAction, { type: 'inquire' }>;

export function ItHelpScreen({ onBack }: { onBack: () => void }) {
  const [text, setText] = useState('');
  const [sentMasked, setSentMasked] = useState<string | null>(null);
  const [result, setResult] = useState<ItHelpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [inquiry, setInquiry] = useState<{ action: Inquire; question: string } | null>(null);
  const checked = useMemo(() => checkInput(text), [text]);
  const line = maskLine(checked);
  const locked = checked.locks.length > 0;

  async function find() {
    if (locked || !text.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiRequest<ItHelpResponse>('POST', '/api/navi/it-help', { text: checked.text }));
      setSentMasked(checked.text);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 찾지 못했어요');
    } finally {
      setLoading(false);
    }
  }

  async function open(id: string) {
    setLoading(true);
    setError(null);
    try {
      setResult(await apiRequest<ItHelpResponse>('POST', '/api/navi/it-help/faq', { id }));
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 열지 못했어요');
    } finally {
      setLoading(false);
    }
  }

  function askIt(r: ItHelpResponse) {
    setInquiry({
      action: { type: 'inquire', text: `${r.inquiryTeam}에 문의하기`, rowId: r.inquiryRowId, team: r.inquiryTeam, task: r.inquiryTask },
      question: itInquiryDraft({ maskedText: sentMasked ?? checked.text, faqTitle: r.faq?.title }),
    });
  }

  return (
    <div className='feature-page it-help'>
      <button type='button' className='link back' onClick={onBack}>
        ← 담당 찾기
      </button>
      <header className='page-head'>
        <p className='eyebrow'>담당 찾기</p>
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
          onChange={(e) => setText(e.target.value)}
          placeholder='오류 창의 글을 그대로 붙여 넣어 주세요'
          aria-label='오류 창의 글'
          maxLength={IT_HELP_TEXT_MAX}
          rows={5}
          autoComplete='off'
          spellCheck={false}
        />
        <div className='it-help-foot'>
          <small className='hint'>
            {text.length} / {IT_HELP_TEXT_MAX}
          </small>
          <button type='submit' disabled={locked || !text.trim() || loading}>
            비슷한 오류 찾기
          </button>
        </div>
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
        {result?.faq && (
          <article className='result-card label-안내' aria-label='담당 안내'>
            <header className='card-head'>
              <span className='kind'>담당</span>
              <span className='label'>안내</span>
            </header>
            <div className='card-body'>
              <p className='headline'>{result.faq.title}</p>
              <ol className='it-steps'>
                {result.faq.steps.map((s) => (
                  <li key={s}>{s}</li>
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
              <p className='headline'>비슷한 IT FAQ를 찾지 못했어요. 아래 버튼으로 {result.inquiryTeam}에 알려 주세요</p>
            </div>
            <div className='card-actions'>
              <button type='button' className='secondary' onClick={() => askIt(result)}>
                {result.inquiryTeam}에 문의하기
              </button>
            </div>
            <p className='tail'>붙여 넣은 글은 저장하지 않아요</p>
          </article>
        )}
        {result && result.others.length > 0 && (
          <div className='it-others'>
            <p className='example-label'>{result.faq ? '비슷한 다른 FAQ' : '이 중에 있나요?'}</p>
            <div className='chips'>
              {result.others.map((o) => (
                <button key={o.id} type='button' className='chip' onClick={() => void open(o.id)}>
                  {o.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {inquiry && <InquirySheet action={inquiry.action} initialQuestion={inquiry.question} onClose={() => setInquiry(null)} />}
    </div>
  );
}
