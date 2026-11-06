import {
  checkInput,
  DEMO_BOARD_BODY_MAX,
  DEMO_BOARD_TEXT,
  DEMO_BOARD_TITLE_MAX,
  type DemoBoardPostRequest,
  type DemoBoardPostResponse,
  type DemoBoardResponse,
  maskLine,
} from '@one-line-desk/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiFailure, apiRequest } from '../api';
import { newRequestId } from '../net';

// 시연 전용 가상 그룹웨어 게시판(11/6 사용자 요청, 새 공지 알림 대상 시연). 가상 그룹웨어 화면(GroupwareDemo) 안의 한 쪽이에요.
// 시연 한 바퀴: 여기서 공지를 올려요 → 한 줄 데스크 공지 사본에 들어가요 → AI가 알림 대상을 제안해요 → 총무가 공지 탭에서 확인하고 [알리기]
// → 대상자에게만 "나에게 해당할 수 있는 새 공지가 있어요" 알림이 가요.
// - 제목·본문은 공통 입력 검사를 브라우저와 서버가 같이 해요(키·주민번호 같은 글은 막고, 이메일·IP는 가려요).
// - 11/6 사용자 결정: 가상 그룹웨어는 시연 무대로만 둬요. 제목·본문 올리기와 읽기 목록뿐이에요(게시판 고르기·댓글·첨부·수정·삭제·권한 없음).
// - 글은 가상 그룹웨어 서버 메모리에만 있어요(7일, 다시 뜨면 비워짐). 브라우저 저장소에 아무것도 넣지 않아요(R13).

const NOT_DEMO = '가상 그룹웨어는 시연에서만 열려요';
const failText = (e: unknown, fallback: string) => (e instanceof ApiFailure ? (e.status === 404 ? NOT_DEMO : e.message) : fallback);

/** 한 줄 데스크 공지 원문 링크(?post=)로 들어오면 그 글을 펼쳐 보여요. */
const linkedPost = () => new URLSearchParams(window.location.search).get('post');

export function GroupwareBoard() {
  const [data, setData] = useState<DemoBoardResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(linkedPost);

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<DemoBoardResponse>('GET', '/api/demo/groupware/board'));
      setMessage(null);
    } catch (e) {
      setMessage(failText(e, '게시판을 열지 못했어요'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PostForm onPosted={() => void load()} />
      <section className='gw-card' aria-label='공지 게시판'>
        <h2>공지 게시판</h2>
        {message && (
          <p className='gw-error' role='alert'>
            {message}
          </p>
        )}
        {data && data.posts.length === 0 && <p className='gw-hint'>올라온 공지가 없어요.</p>}
        <ul className='gw-board-list'>
          {data?.posts.map((p) => (
            <li key={p.id} className={open === p.id ? 'gw-post open' : 'gw-post'}>
              <button type='button' className='gw-post-head' aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
                <strong>{p.title}</strong>
                <small>{p.createdAt}</small>
              </button>
              {open === p.id && <p className='gw-post-body'>{p.body}</p>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function PostForm({ onPosted }: { onPosted: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => newRequestId());
  const titleCheck = useMemo(() => checkInput(title), [title]);
  const bodyCheck = useMemo(() => checkInput(body), [body]);
  const locks = [...new Set([...titleCheck.locks, ...bodyCheck.locks].map((l) => l.message))];
  const masks = [maskLine(titleCheck), maskLine(bodyCheck)].filter(Boolean);
  const ready = title.trim() !== '' && body.trim() !== '' && locks.length === 0 && !busy;

  async function post() {
    if (!ready) return;
    setBusy(true);
    setMessage(null);
    setDone(null);
    try {
      const req: DemoBoardPostRequest = { title: title.trim(), body: body.trim(), requestId };
      const res = await apiRequest<DemoBoardPostResponse>('POST', '/api/demo/groupware/board/posts', req);
      setDone(
        !res.copy.copied
          ? DEMO_BOARD_TEXT.notCopied
          : res.copy.audience === 'sent'
            ? DEMO_BOARD_TEXT.copiedAuto
            : res.copy.audience === 'pending'
              ? DEMO_BOARD_TEXT.copied
              : DEMO_BOARD_TEXT.copiedOff,
      );
      setTitle('');
      setBody('');
      setRequestId(newRequestId());
      onPosted();
    } catch (e) {
      setMessage(failText(e, '공지를 올리지 못했어요'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className='gw-card' aria-label='공지 올리기'>
      <h1>공지 올리기</h1>
      <label className='gw-label'>
        제목
        <input type='text' value={title} maxLength={DEMO_BOARD_TITLE_MAX} autoComplete='off' onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className='gw-label'>
        본문
        <textarea value={body} maxLength={DEMO_BOARD_BODY_MAX} rows={5} autoComplete='off' onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className='gw-hint'>예) 3층 화장실은 11월 9일 하루 공사로 쓸 수 없어요. 문의는 총무팀으로 해 주세요.</p>
      <p className='gw-hint'>{DEMO_BOARD_TEXT.hint}</p>
      {locks.map((l) => (
        <p key={l} className='gw-error'>
          {l}
        </p>
      ))}
      {masks.map((m) => (
        <p key={m} className='gw-hint'>
          {m}
        </p>
      ))}
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
      <button type='button' className='gw-button gw-primary' disabled={!ready} onClick={() => void post()}>
        {busy ? '올리는 중' : '올리기'}
      </button>
    </section>
  );
}
