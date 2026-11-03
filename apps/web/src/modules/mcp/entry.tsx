import {
  type Card,
  type ConsentDecisionResponse,
  type ConsentInfo,
  kstTime,
  ROOM_CONDITIONS_VARIANT,
  type RoomCardsResponse,
  type RoomRecheckRequest,
} from '@one-line-desk/shared';
import { useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { useActions } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import type { ScreenProps } from '../types';
import { failMessage, josa } from './text';

// 바깥 주소로 들어오는 MCP 화면(M3·M4): 연결 동의 시트(/oauth/consent), 앱 확인 링크 진입(/r/<토큰>).
// 그 주소로 들어올 때만 써서 처음 열 때 따로 불러요(registry의 lazyPart). index에서 다시 내보내지 마세요.
// 문구는 docs/화면설계.md "보안이 보이는 문구"를 그대로 써요. 브라우저 저장소에는 아무것도 넣지 않아요(R13).

type ConsentView =
  | { kind: 'loading' }
  | { kind: 'ready'; info: Extract<ConsentInfo, { status: 'ready' }> }
  | { kind: 'message'; text: string }
  | { kind: 'leaving'; text: string };

const CONSENT_MESSAGES = {
  'not-allowed': '회사가 허락하지 않은 앱이라 연결할 수 없어요',
  'no-tools': '지금 연결할 수 있는 도구가 없어요',
  expired: '연결 요청 시간이 지났어요. AI 앱에서 다시 연결해 주세요',
  invalid: '연결 요청이 맞지 않아요. AI 앱에서 다시 연결해 주세요',
} as const;

/** 연결 동의 시트(M4). 사내 로그인 뒤 S6 위에 떠요. 버튼 둘은 무게가 같고 기본 선택이 없어요. */
export function ConsentScreen({ me }: ScreenProps) {
  const actions = useActions();
  const [view, setView] = useState<ConsentView>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams(window.location.search);
  const req = params.get('req');
  const urlError = params.get('error');

  useEffect(() => {
    if (urlError || !req) {
      setView({ kind: 'message', text: urlError === 'not-allowed' ? CONSENT_MESSAGES['not-allowed'] : CONSENT_MESSAGES.invalid });
      return;
    }
    let alive = true;
    apiRequest<ConsentInfo>('GET', `/api/mcp/consent?req=${encodeURIComponent(req)}`)
      .then((info) => {
        if (!alive) return;
        setView(info.status === 'ready' ? { kind: 'ready', info } : { kind: 'message', text: CONSENT_MESSAGES[info.status] });
      })
      .catch((e: unknown) => alive && setView({ kind: 'message', text: failMessage(e, '연결 요청을 확인하지 못했어요') }));
    return () => {
      alive = false;
    };
  }, [req, urlError]);

  async function decide(decision: 'allow' | 'deny', appName: string) {
    if (busy || !req) return;
    setBusy(true);
    try {
      const res = await apiRequest<ConsentDecisionResponse>('POST', '/api/mcp/consent', { req, decision });
      setView({ kind: 'leaving', text: res.result === 'allowed' ? `연결됐어요. ${appName}${josa(appName, '로')} 돌아가세요` : '연결하지 않았어요' });
      window.location.assign(res.redirectTo);
    } catch (e) {
      setBusy(false);
      setView({ kind: 'message', text: failMessage(e, '지금 연결하지 못했어요. AI 앱에서 다시 연결해 주세요') });
    }
  }

  const backToApp = (
    <button type='button' className='secondary small' onClick={() => void actions.run({ type: 'navigate', text: '마이 페이지로 가기', to: 'mine' })}>
      마이 페이지로 가기
    </button>
  );

  if (view.kind === 'loading') return <p className='hint'>연결 요청을 확인하는 중이에요</p>;
  if (view.kind === 'message' || view.kind === 'leaving') {
    return (
      <section className='card' aria-live='polite'>
        <h1>AI 앱 연결</h1>
        <p>{view.text}</p>
        {view.kind === 'message' && <div className='actions'>{backToApp}</div>}
      </section>
    );
  }

  const { appName, redirectHost, tools, roomsWrite } = view.info;
  return (
    <div className='mine' aria-labelledby='consent-title'>
      <section className='card'>
        <h1 id='consent-title'>
          {appName}
          {josa(appName, '가')} 한 줄 데스크에 연결하려고 해요 · 회사가 허락한 앱이에요
        </h1>
        <p className='hint'>
          내 회사 계정으로 연결돼요({me.displayName}) · 연결이 끝나면 {redirectHost}에 돌아가요
        </p>
      </section>

      <section className='card'>
        <h2>읽는 것</h2>
        <ul className='plain'>
          {tools.includes('rooms.read') && <li>빈 회의실 찾기: 회의실·층·시간·인원·장비만{roomsWrite ? '' : ' · 예약은 그룹웨어에서 해요'}</li>}
          {tools.includes('notices.read') && <li>공지 찾기: 허용 게시판 공지의 제목·게시일·원문 링크만</li>}
        </ul>
      </section>

      <section className='card'>
        <h2>못 하는 것</h2>
        <ul className='plain'>
          <li>읽기만 해요. 예약·취소·게시는 못 해요</li>
          <li>누가 예약했는지, 회의 제목은 보내지 않아요</li>
          <li>담당 안내·같이 채워요는 연결하지 않아요</li>
        </ul>
      </section>

      <p className='mask-line'>찾은 결과는 {appName}의 AI 모델로 보내져요</p>
      <p className='hint'>끊는 곳: 마이 페이지 &gt; 연결된 AI 앱</p>

      <div className='actions' role='group' aria-label='연결 동의'>
        <button type='button' className='secondary' disabled={busy} onClick={() => void decide('allow', appName)}>
          연결 허락
        </button>
        <button type='button' className='secondary' disabled={busy} onClick={() => void decide('deny', appName)}>
          허락하지 않기
        </button>
      </div>
      <p className='hint'>
        부른 도구와 시각만 남아요. 무엇을 찾았는지는 남지 않아요 · 언제든 마이 페이지 &gt; 연결된 AI 앱에서 끊을 수 있어요. 퇴사하면 자동으로 끊겨요
      </p>
    </div>
  );
}

type LinkView = { kind: 'loading' } | { kind: 'ok'; checkedAt: string; cards: Card[] } | { kind: 'not-owner' } | { kind: 'failed'; message: string };

/**
 * 앱 확인 링크로 들어온 S2(M3). 로그인 뒤 회의실 쓰기 경로가 토큰 주인을 검사하고 지금 다시 조회해요.
 * 링크를 연 건 확인이 아니에요. [이 회의실로 예약] → 확인 시트 [예약하기]가 유일한 확인이에요(R2).
 */
export function LinkEntry({ token }: ScreenProps & { token: string }) {
  const actions = useActions();
  const [view, setView] = useState<LinkView>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    const body: RoomRecheckRequest = { proposalToken: token };
    apiRequest<RoomCardsResponse>('POST', '/api/rooms/recheck', body)
      .then((res) => alive && setView({ kind: 'ok', checkedAt: res.checkedAt, cards: res.cards }))
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiFailure && e.code === 'not-owner') setView({ kind: 'not-owner' });
        else setView({ kind: 'failed', message: failMessage(e, '지금 다시 확인하지 못했어요') });
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const toAsk = (
    <button type='button' className='secondary' onClick={() => void actions.run({ type: 'navigate', text: '회의실에서 찾기', to: 'rooms' })}>
      회의실에서 찾기
    </button>
  );

  if (view.kind === 'loading') return <p className='hint'>Claude에서 가져온 후보를 지금 다시 확인하는 중이에요</p>;
  if (view.kind === 'not-owner' || view.kind === 'failed') {
    return (
      <section className='card' aria-live='polite'>
        <p>{view.kind === 'not-owner' ? '다른 사람이 받은 링크라 열 수 없어요' : view.message}</p>
        <div className='actions'>{toAsk}</div>
      </section>
    );
  }

  const checked = Date.parse(view.checkedAt);
  // 링크를 연 사람은 고른 회의실을 먼저 봐야 해요. 조건 고치기 카드는 회의실 카드 뒤로 보내요(10/26 MCP 베타 시험).
  const ordered = [...view.cards.filter((c) => c.variant !== ROOM_CONDITIONS_VARIANT), ...view.cards.filter((c) => c.variant === ROOM_CONDITIONS_VARIANT)];
  return (
    <div className='ask' aria-label='Claude에서 가져온 후보'>
      <p className='mask-line'>Claude에서 가져온 후보예요. 지금 다시 확인했어요(현황 {Number.isNaN(checked) ? '--:--' : kstTime(checked)} 기준)</p>
      {ordered.map((card) => (
        <CardView key={card.id} card={card} onAction={(action, c) => actions.run(action, c)} />
      ))}
      <div className='actions'>{toAsk}</div>
    </div>
  );
}
