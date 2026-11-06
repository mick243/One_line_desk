import { CAFE_LIMITS, CAFE_NEXT_STATUS, CAFE_STATUS_LABEL, CAFE_TEXT, type CafeBoardResponse, type CafeStatusRequest } from '@one-line-desk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import './cafe.css';

// S8 카페 판(바리스타의 홈, F4 1묶음, ADR-29). 머리(영업 중·[영업 끝] / 영업 전·[영업 시작]) → 판 머리 문구 → 주문 줄 → 메뉴 품절 바꾸기.
// 3초마다 배경 요청으로 새로 읽어요(쉬는 시간을 늘리지 않아요, ADR-20). 판이 2분 넘게 안 보이면 서버가 주문 받기를 멈춰요.
// 이름·가명 ID·금액은 응답에도 화면에도 없어요. 새 주문 소리는 [영업 시작]을 누른 뒤에만 나요(브라우저는 사람이 한 번 눌러야 소리를 내요).

const FRESH_MS = 6_000;

/** 짧은 "띵" 한 번. 소리를 못 내도 판은 그대로예요. */
function chime(audio: AudioContext): void {
  try {
    const at = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, at);
    osc.frequency.setValueAtTime(1175, at + 0.12);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.45);
  } catch {
    // 소리를 못 내도 줄 깜빡임으로 알아요.
  }
}

/** 사람이 누른 순간에만 만들어요(자동 재생 막힘). 지원하지 않는 브라우저면 null이에요. */
function startAudio(): AudioContext | null {
  try {
    const Ctor = window.AudioContext;
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}

export function CafeBoard() {
  const [data, setData] = useState<CafeBoardResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [soundOn, setSoundOn] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async (background: boolean) => {
    try {
      const res = await apiRequest<CafeBoardResponse>('GET', '/api/cafe/board', undefined, { background });
      // 처음 불러온 것 말고, 새로 들어온 주문만 깜빡이고 소리를 내요.
      if (seen.current) {
        const added = res.orders.filter((o) => !seen.current!.has(o.id)).map((o) => o.id);
        if (added.length) {
          setFresh(new Set(added));
          if (res.open && audio.current) chime(audio.current);
        }
      }
      seen.current = new Set(res.orders.map((o) => o.id));
      setData(res);
      setFailed(null);
    } catch (e) {
      setFailed(e instanceof ApiFailure ? e.message : '카페 판을 불러오지 못했어요');
    }
  }, []);

  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => void load(true), CAFE_LIMITS.boardPollMs);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!fresh.size) return;
    const id = window.setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => window.clearTimeout(id);
  }, [fresh]);

  // 판을 떠나면 소리를 끄고 놓아요.
  useEffect(
    () => () => {
      void audio.current?.close().catch(() => undefined);
      audio.current = null;
    },
    [],
  );

  const turnSoundOn = useCallback(() => {
    if (!audio.current) audio.current = startAudio();
    void audio.current?.resume().catch(() => undefined);
    setSoundOn(audio.current !== null);
  }, []);

  async function write(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요');
    } finally {
      setBusy(null);
      await load(false);
    }
  }

  if (!data) {
    return (
      <div className='feature-page cafe-board'>
        <BoardHead />
        {failed ? (
          <>
            <p className='empty'>{failed}</p>
            <button type='button' className='secondary small' onClick={() => void load(false)}>
              다시 불러오기
            </button>
          </>
        ) : (
          <div className='skeleton' aria-label='불러오는 중' />
        )}
      </div>
    );
  }

  return (
    <BoardView
      data={data}
      fresh={fresh}
      busy={busy}
      error={error ?? failed}
      soundOn={soundOn}
      onOpen={() =>
        void write('open', async () => {
          // [영업 시작]을 누른 이 순간에 소리를 켜요.
          turnSoundOn();
          await apiRequest('POST', '/api/cafe/board/open');
        })
      }
      onClose={() =>
        void write('close', async () => {
          await apiRequest('POST', '/api/cafe/board/close');
          void audio.current?.close().catch(() => undefined);
          audio.current = null;
          setSoundOn(false);
        })
      }
      onSound={turnSoundOn}
      onAdvance={(id, to) => void write(`${id}:${to}`, () => apiRequest('POST', `/api/cafe/orders/${id}/status`, { to } satisfies CafeStatusRequest))}
      onSoldOut={(id, soldOut) => void write(`menu:${id}`, () => apiRequest('PUT', `/api/cafe/menu/${id}/sold-out`, { soldOut }))}
    />
  );
}

function BoardHead() {
  return (
    <header className='page-head'>
      <p className='eyebrow'>카페 판</p>
      <h1>들어온 주문</h1>
    </header>
  );
}

/** 카페 판 그리기(시험이 이 부품을 바로 그려요). 받은 값에는 이름·금액이 없고, 여기서도 만들지 않아요. */
export function BoardView({
  data,
  fresh,
  busy,
  error,
  soundOn,
  onOpen,
  onClose,
  onSound,
  onAdvance,
  onSoldOut,
}: {
  data: CafeBoardResponse;
  fresh: ReadonlySet<string>;
  busy: string | null;
  error: string | null;
  soundOn: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSound: () => void;
  onAdvance: (id: string, to: CafeStatusRequest['to']) => void;
  onSoldOut: (id: string, soldOut: boolean) => void;
}) {
  return (
    <div className='feature-page cafe-board'>
      <BoardHead />
      <section className={data.open ? 'card cafe-duty open' : 'card cafe-duty'} aria-label='영업'>
        <p className='cafe-duty-state'>{data.open ? '영업 중' : '영업 전'}</p>
        {data.open ? (
          <button type='button' className='neutral small' disabled={busy !== null} onClick={onClose}>
            {busy === 'close' ? '처리하는 중' : '영업 끝'}
          </button>
        ) : (
          <button type='button' className='primary' disabled={busy !== null} onClick={onOpen}>
            {busy === 'open' ? '처리하는 중' : '영업 시작'}
          </button>
        )}
        {data.open && !soundOn && (
          <button type='button' className='secondary small' onClick={onSound}>
            새 주문 소리 켜기
          </button>
        )}
      </section>
      <p className='notice-line cafe-board-head'>{CAFE_TEXT.boardHead}</p>
      {error && (
        <p className='lock-line' role='alert'>
          {error}
        </p>
      )}

      <section className='card' aria-label='주문 줄'>
        <h2>주문 {data.orders.length}건</h2>
        {data.orders.length === 0 && <p className='empty'>아직 들어온 주문이 없어요</p>}
        <ul className='cafe-board-list'>
          {data.orders.map((o) => {
            const next = CAFE_NEXT_STATUS[o.status];
            const key = next ? `${o.id}:${next.to}` : '';
            return (
              <li key={o.id} className={`cafe-board-row status-${o.status}${fresh.has(o.id) ? ' fresh' : ''}`}>
                <span className='cafe-no' aria-label={`픽업 번호 ${o.pickupNo}`}>
                  {o.pickupNo}
                </span>
                <div className='cafe-board-body'>
                  <ul className='cafe-board-lines'>
                    {o.lines.map((l, i) => (
                      <li key={i}>
                        <strong>{l.name}</strong>
                        {l.options.length > 0 && <span className='cafe-opts'>{l.options.join('·')}</span>}
                        <span className='cafe-qty-text'>× {l.qty}</span>
                      </li>
                    ))}
                  </ul>
                  <span className='hint'>
                    픽업 {o.pickupLabel} · 주문 {o.orderedAt} · {CAFE_STATUS_LABEL[o.status]}
                  </span>
                </div>
                {next && (
                  <button
                    type='button'
                    className='secondary cafe-step'
                    disabled={busy !== null}
                    onClick={() => onAdvance(o.id, next.to as CafeStatusRequest['to'])}
                  >
                    {busy === key ? '처리하는 중' : next.button}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className='card' aria-label='메뉴 품절'>
        <h2>메뉴 품절</h2>
        <ul className='cafe-soldout-list'>
          {data.menu.map((m) => (
            <li key={m.id}>
              <span>{m.name}</span>
              {m.soldOut && <span className='chip'>품절</span>}
              <button
                type='button'
                className={m.soldOut ? 'secondary small' : 'neutral small'}
                disabled={busy !== null}
                onClick={() => onSoldOut(m.id, !m.soldOut)}
              >
                {busy === `menu:${m.id}` ? '처리하는 중' : m.soldOut ? '다시 팔기' : '품절로 바꾸기'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
