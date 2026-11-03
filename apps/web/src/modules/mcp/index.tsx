import {
  type Card,
  type ConnectedApp,
  type ConnectionsResponse,
  type ConsentDecisionResponse,
  type ConsentInfo,
  kstTime,
  type LinkOpenRequest,
  type LinkOpenResponse,
  type McpScope,
  ROOM_CONDITIONS_VARIANT,
  type RoomCardsResponse,
  type RoomRecheckRequest,
} from '@one-line-desk/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { ConfirmSheet, useActions, useListVersion } from '../../components/ActionHost';
import { CardView } from '../../components/CardView';
import type { ScreenProps, WebModules } from '../types';

// 읽기 전용 MCP 화면 부품(M3·M4): S6 "연결된 AI 앱", 연결 동의 시트, 앱 확인 링크 진입.
// 문구는 docs/화면설계.md "보안이 보이는 문구"를 그대로 써요. 브라우저 저장소에는 아무것도 넣지 않아요(R13).

const SCOPE_LABEL: Record<McpScope, string> = { 'rooms.read': '회의실', 'notices.read': '공지', 'navi.read': '담당 찾기', 'mine.read': '내 요청 상태' };

/** 앱 이름 뒤 조사(가/이, 로/으로). 한글이 아니면 '가'·'로'로 둬요(Claude가, Claude로). */
function josa(name: string, kind: '가' | '로'): string {
  const code = name.trim().charCodeAt(name.trim().length - 1);
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return kind;
  const final = (code - 0xac00) % 28;
  if (kind === '가') return final === 0 ? '가' : '이';
  return final === 0 || final === 8 ? '로' : '으로';
}

function failMessage(e: unknown, fallback: string): string {
  return e instanceof ApiFailure ? e.message : fallback;
}

function formatDay(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return m && d ? `${Number(m)}월 ${Number(d)}일` : isoDate;
}

/** S6 "연결된 AI 앱" 칸: 앱 이름 · 연결한 날 · 읽을 수 있는 것 칩 · [끊기]. "마지막 사용"은 없어요(M4). */
export function ConnectedApps() {
  const { version, background } = useListVersion();
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState<ConnectedApp | null>(null);

  const load = useCallback(async (bg = false) => {
    try {
      setData(await apiRequest<ConnectionsResponse>('GET', '/api/mcp/connections', undefined, { background: bg }));
      setError('');
    } catch (e) {
      setError(failMessage(e, '연결된 AI 앱을 불러오지 못했어요'));
    }
  }, []);

  useEffect(() => {
    void load(background());
  }, [load, version]);

  return (
    <section className='card' aria-labelledby='connected-apps-title'>
      <h2 id='connected-apps-title'>연결된 AI 앱</h2>
      {error && <p className='lock-line'>{error}</p>}
      {data && !data.available && <p className='hint'>지금 연결할 수 있는 도구가 없어요</p>}
      {data && data.apps.length === 0 && <p className='empty'>연결된 AI 앱이 없어요. AI 앱에서 연결하면 여기에 보여요.</p>}
      {data && data.apps.length > 0 && (
        <ul className='plain'>
          {data.apps.map((app) => (
            <li key={app.clientId}>
              <p>
                <strong>{app.appName}</strong> <span className='hint'>· {formatDay(app.connectedOn)}에 연결</span>
                {app.devices > 1 && <span className='hint'> · 기기 {app.devices}대</span>}
              </p>
              <div className='chips' aria-label='읽을 수 있는 것'>
                {app.scopes.map((scope) => (
                  <span key={scope} className='chip'>
                    {SCOPE_LABEL[scope]}
                    {data.available && !data.tools.includes(scope) ? ' · 지금 꺼져 있어요' : ''}
                  </span>
                ))}
                {/* 11/3 새 범위: 지금 켜진 도구인데 이 연결이 허락하지 않은 것. AI 앱에서 부르면 다시 허락을 받아요. */}
                {data.available &&
                  data.tools
                    .filter((scope) => !app.scopes.includes(scope))
                    .map((scope) => (
                      <span key={scope} className='chip'>
                        {SCOPE_LABEL[scope]} · 허락이 필요해요
                      </span>
                    ))}
                {!data.available && <span className='hint'>쓸 수 있는 도구 없음</span>}
              </div>
              <div className='actions'>
                <button
                  type='button'
                  className='secondary small'
                  onClick={() => {
                    setNotice('');
                    setConfirming(app);
                  }}
                >
                  끊기
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className='hint'>{notice}</p>}
      {data && data.cliApps.length > 0 && <CliGuide mcpUrl={data.mcpUrl} apps={data.cliApps} />}
      {confirming && (
        <ConfirmSheet
          sheet={{
            title: `${confirming.appName} 연결 끊기`,
            lines: [
              `${confirming.appName} 연결을 끊어요${confirming.devices > 1 ? `(기기 ${confirming.devices}대 모두)` : ''}. ${confirming.appName}에서 한 줄 데스크를 더 부를 수 없어요. 이미 ${confirming.appName}${josa(confirming.appName, '로')} 간 결과는 그쪽 기록에 남을 수 있어요`,
            ],
            confirmLabel: '끊기',
          }}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              await apiRequest('DELETE', `/api/mcp/connections/${encodeURIComponent(confirming.clientId)}`);
              setNotice('끊었어요');
            } catch (e) {
              setError(failMessage(e, '지금 끊지 못했어요. 다시 해 주세요'));
            } finally {
              setConfirming(null);
              await load();
            }
          }}
        />
      )}
    </section>
  );
}

/**
 * CLI 앱마다 터미널에 넣을 명령(11/2, MCP_UX_TEST U1~U3). 비밀 없이 클라이언트 ID만 넣고, 로그인은 연결할 때 사내 로그인 → 동의 시트로 해요.
 * 앱 이름이 표에 없으면 MCP 주소와 클라이언트 ID만 보여 줘요.
 */
const CLI_COMMANDS: Record<string, (url: string, clientId: string) => string[]> = {
  'Claude Code': (url, id) => [`claude mcp add --transport http --client-id ${id} one-line-desk ${url}`, '그다음 Claude Code에서 /mcp → one-line-desk → 인증'],
  Codex: (url, id) => [`codex mcp add one-line-desk --url ${url}`, `codex mcp login one-line-desk --oauth-client-id ${id}`],
};

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className='cli-line'>
      <code>{text}</code>
      <button
        type='button'
        className='secondary small'
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? '복사했어요' : '복사'}
      </button>
    </div>
  );
}

/** S6 "터미널 AI 앱 연결하는 법": 회사가 허락한 CLI 앱만 보여요. 비밀 값은 없어요. */
function CliGuide({ mcpUrl, apps }: { mcpUrl: string; apps: ConnectionsResponse['cliApps'] }) {
  return (
    <details className='cli-guide'>
      <summary>터미널 AI 앱(Claude Code·Codex) 연결하는 법</summary>
      <p className='hint'>명령을 터미널에 넣으면 브라우저가 열려요. 사내 로그인 뒤 동의 시트에서 [연결 허락]을 누르면 끝나요. 비밀 값은 필요 없어요.</p>
      {apps.map((app) => {
        const lines = CLI_COMMANDS[app.appName]?.(mcpUrl, app.clientId);
        return (
          <div key={app.clientId} className='cli-app'>
            <h3>{app.appName}</h3>
            {lines ? (
              lines.map((line) =>
                line.includes(mcpUrl) || line.includes(app.clientId) ? (
                  <CopyLine key={line} text={line} />
                ) : (
                  <p key={line} className='hint'>
                    {line}
                  </p>
                ),
              )
            ) : (
              <>
                <CopyLine text={mcpUrl} />
                <p className='hint'>클라이언트 ID: {app.clientId}</p>
              </>
            )}
          </div>
        );
      })}
      <p className='hint'>같은 앱을 다른 기기에서 연결해도 앞 기기는 끊기지 않아요. 끊을 때는 위 [끊기]를 눌러요.</p>
    </details>
  );
}

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
          {tools.includes('navi.read') && <li>담당 찾기: 업무 분장표의 받을 팀·창구·할 일, IT 오류 FAQ, 첫 2주 할 일만 · 묻는 글은 남지 않아요</li>}
          {tools.includes('mine.read') && <li>내 요청 상태: 내가 보낸 문의·휴가 요청의 처리 상태와 내 회의실 예약만</li>}
        </ul>
      </section>

      <section className='card'>
        <h2>못 하는 것</h2>
        <ul className='plain'>
          <li>읽기와 준비만 해요. 보내기·예약·취소·게시는 앱에서 직접 눌러요</li>
          <li>누가 예약했는지, 회의 제목은 보내지 않아요</li>
          <li>담당자 이름, 문의와 답장 글, 남은 연차는 보내지 않아요</li>
          <li>같이 채워요는 연결하지 않아요</li>
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

type Inquire = Extract<Card['actions']['secondary'][number], { type: 'inquire' }>;

type LinkView =
  | { kind: 'loading' }
  | { kind: 'ok'; checkedAt: string; cards: Card[] }
  | { kind: 'inquiry'; action: Inquire }
  | { kind: 'message'; text: string }
  | { kind: 'not-owner' }
  | { kind: 'failed'; message: string };

/** 문의 링크가 양식을 열지 못할 때(11/3). */
const LINK_MESSAGES = {
  gone: '분장표가 바뀌어서 그 업무를 찾지 못했어요. 여기서 다시 찾아 주세요',
  expired: '링크 시간이 지났어요. AI 앱에서 다시 찾거나 여기서 찾아 주세요',
  off: '지금은 담당 찾기가 꺼져 있어요',
} as const;

/**
 * 앱 확인 링크로 들어온 S2(M3). 먼저 서버가 링크 종류와 토큰 주인을 확인해요(/api/mcp/link).
 * - 회의실: 회의실 쓰기 경로가 지금 다시 조회해요. [이 회의실로 예약] → 확인 시트 [예약하기]가 유일한 확인이에요(R2).
 * - 담당 팀 문의(11/3): 그 팀 문의 양식을 빈 칸으로 열어요. 질문 글은 링크에 없어서 직원이 여기서 써요(R13). [보내기] → 확인 시트가 유일한 확인이에요.
 * 링크를 연 것만으로는 아무것도 쓰지 않아요.
 */
export function LinkEntry({ token, InquirySheet }: ScreenProps & { token: string; InquirySheet: WebModules['InquirySheet'] }) {
  const actions = useActions();
  const [view, setView] = useState<LinkView>({ kind: 'loading' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sentAt] = useState(actions.writes);

  useEffect(() => {
    let alive = true;
    const body: RoomRecheckRequest = { proposalToken: token };
    const open: LinkOpenRequest = { proposalToken: token };
    apiRequest<LinkOpenResponse>('POST', '/api/mcp/link', open)
      .then(async (link) => {
        if (link.kind === 'inquiry') {
          if (!alive) return;
          setView({ kind: 'inquiry', action: { type: 'inquire', text: `${link.team}에 문의하기`, rowId: link.rowId, team: link.team, task: link.task } });
          setSheetOpen(true);
          return;
        }
        if (link.kind !== 'rooms') {
          if (alive) setView({ kind: 'message', text: LINK_MESSAGES[link.kind] });
          return;
        }
        const res = await apiRequest<RoomCardsResponse>('POST', '/api/rooms/recheck', body);
        if (alive) setView({ kind: 'ok', checkedAt: res.checkedAt, cards: res.cards });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiFailure && e.code === 'not-owner') setView({ kind: 'not-owner' });
        else setView({ kind: 'failed', message: failMessage(e, '지금 다시 확인하지 못했어요') });
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const toNavi = (
    <button type='button' className='secondary' onClick={() => void actions.run({ type: 'navigate', text: '담당 찾기에서 찾기', to: 'navi' })}>
      담당 찾기에서 찾기
    </button>
  );

  if (view.kind === 'inquiry') {
    const { action } = view;
    const sent = actions.writes !== sentAt;
    return (
      <div className='ask' aria-label='AI 앱에서 가져온 담당'>
        <p className='mask-line'>Claude에서 가져온 담당이에요. 문의 내용은 여기서 직접 써 주세요</p>
        <section className='card'>
          <p>
            <strong>{action.team}</strong> · {action.task}
          </p>
          {sent && <p className='hint'>보냈어요. 문의하기 "내 문의"에서 처리 상태를 볼 수 있어요</p>}
          <div className='actions'>
            {!sent && (
              <button type='button' className='primary' onClick={() => setSheetOpen(true)}>
                {action.text}
              </button>
            )}
            {toNavi}
          </div>
        </section>
        {sheetOpen && <InquirySheet action={action} initialQuestion='' onClose={() => setSheetOpen(false)} />}
      </div>
    );
  }
  if (view.kind === 'message') {
    return (
      <section className='card' aria-live='polite'>
        <p>{view.text}</p>
        <div className='actions'>{toNavi}</div>
      </section>
    );
  }

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
