import { type ConnectedApp, type ConnectionsResponse, type McpScope } from '@one-line-desk/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../api';
import { ConfirmSheet, useListVersion } from '../../components/ActionHost';
import { failMessage, josa } from './text';

// 읽기 전용 MCP 화면 부품(M3·M4): S6 "연결된 AI 앱".
// 연결 동의 시트·앱 확인 링크 진입(./entry)은 바깥 주소로 들어올 때만 써서 처음 열 때 따로 불러요(registry의 lazyPart).
// 여기서 다시 내보내면 첫 화면에 같이 묶이니 내보내지 않아요.
// 문구는 docs/화면설계.md "보안이 보이는 문구"를 그대로 써요. 브라우저 저장소에는 아무것도 넣지 않아요(R13).

const SCOPE_LABEL: Record<McpScope, string> = {
  'rooms.read': '회의실',
  'notices.read': '공지',
  'navi.read': '문의하기',
  'mine.read': '내 요청 상태',
  'leave.prepare': '휴가 준비',
  'pantry.read': '같이 채워요',
};

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
