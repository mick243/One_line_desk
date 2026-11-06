import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
// 운영은 .env를 읽지 않아요. 값은 배포가 프로세스 환경으로만 넣어요. 이미지에 섞여 들어간 파일이 빠진 값을 몰래 채우지 않게 해요
// (10/29 배포 준비 회의 A2). 사내 프록시·인증서 값(NODE_USE_ENV_PROXY·NODE_EXTRA_CA_CERTS)도 프로세스가 뜰 때만 읽혀서 파일로는 듣지 않아요.
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** 운영에서 서버가 내보낼 웹 화면 파일(npm run build 결과) 기본 위치 */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

/**
 * 시연 배포에서 처음부터 켜 둘 수 있는 운영 스위치(DESK_DEMO_SWITCHES, 11/4). 회의실 쓰기·채팅 자동 실행·같은 팀 일정만이에요.
 * cafeteria(11/6, ADR-29)는 깃발이 아니라 모듈 스위치예요. 넣으면 사내 카페 모듈이 '켬'으로 시작해요(출시 기본은 끔).
 */
export const DEMO_SWITCHES = ['roomsWrite', 'autoActions', 'teamSchedule', 'cafeteria'] as const;
export type DemoSwitch = (typeof DEMO_SWITCHES)[number];

export interface ServerConfig {
  port: number;
  /** 웹 앱 주소. MCP 앱 확인 링크와 인가 리디렉트에 써요. */
  publicBaseUrl: string;
  sessionSecret: string;
  pseudonymSecret: string;
  proposalSecret: string;
  /** MCP 접근·갱신 토큰을 봉인하는 비밀 값. 세션 비밀과 따로 둬요. */
  mcpTokenSecret: string;
  databaseUrl: string | undefined;
  noRetentionContractConfirmed: boolean;
  aiProvider: AiProviderName;
  aiModel: string;
  /** 비어 있는 DB에 가상 자료(등급 0)를 넣을지. 시연에서만 기본으로 켜요. */
  seedDemo: boolean;
  production: boolean;
  /**
   * 시연 배포인지(mock 판정 한 곳, L-16). 참이면 모의 로그인(가상 직원 고르기)·가상 자료·모의 바깥 어댑터·시연 MCP 클라이언트를 열어요.
   * 개발은 늘 참이고, 운영(NODE_ENV=production)은 DESK_MOCK_LOGIN=true를 넣은 시연 배포일 때만 참이에요.
   */
  demo: boolean;
  /** 서버가 뜰 때 마이그레이션을 적용할지(L-22). 시연은 켜고, 운영은 꺼서 앱 계정에 표 만들기 권한이 없어도 떠요(먼저 npm run db:migrate). */
  migrateOnStart: boolean;
  /** 서버가 듣는 주소. 개발은 localhost, 운영(컨테이너)은 0.0.0.0이에요. */
  host: string;
  /** 앞단 프록시를 믿을지(Fastify trustProxy). true 또는 믿을 프록시 주소 목록(쉼표)이에요. 없거나 none이면 믿지 않아요. 운영은 꼭 적어요. */
  trustProxy: boolean | string;
  /** 로그인·직원 명단. mock = 앱 안 가상 직원, keycloak = 임시 IdP(npm run idp:up) 또는 같은 방식의 OIDC IdP */
  idp:
    { kind: 'mock' } | { kind: 'keycloak'; issuer: string; clientId: string; clientSecret: string; directoryClientId: string; directoryClientSecret: string };
  /** 넣으면 Slack DM을 실제로 보내요(봇 권한 users:read.email·im:write·chat:write). 없으면 모의 Slack이에요. */
  slackBotToken: string | undefined;
  /**
   * 앱이 회사 IdP 로그인의 MFA 근거를 확인할지(ADR-20). off = IdP 조건부 접근에 맡겨요(기본), always = 근거가 없으면 세션을 만들지 않아요.
   * 근거는 ID 토큰의 amr(mfaAmr 중 하나) 또는 acr(mfaAcr 중 하나)이에요. IdP마다 값이 달라서 설정으로 받아요.
   */
  requireMfa: 'off' | 'always';
  mfaAmr: string[];
  mfaAcr: string[];
  /** 로그인 요청에 넣을 acr_values(선택). IdP가 이 값으로 MFA를 요구해요. */
  acrValues: string | undefined;
  /**
   * 서버가 내보낼 웹 화면 파일 폴더(10/29 배포 준비 회의 A3). 운영은 기본으로 apps/web/dist를 주고, 없으면 뜨지 않아요.
   * 개발은 Vite가 화면을 줘서 비워 둬요. DESK_WEB_DIST로 바꿀 수 있어요.
   * DESK_WEB_DIST=none이면 화면을 주지 않아요. 웹 화면을 다른 곳(Vercel)이 주고 이 서버는 API만 받을 때예요(10/30).
   */
  webDist: string | undefined;
  /**
   * 떠 있는 판(보통 커밋). 이미지를 만들 때 DESK_BUILD로 넣어 웹과 서버가 같은 값을 가져요(10/29 배포 준비 회의 D1).
   * 모든 응답 머리 x-desk-build로 내보내서, 오래 연 옛 화면이 새 판을 알아채요. 넣지 않으면 dev예요.
   */
  build: string;
  /**
   * 정한 명단(15명 안쪽) 밖으로 넓힌 시연인지(DESK_DEMO_WIDE=true, 10/29 배포 준비 회의 쟁점 5).
   * 참이면 문의를 저장하지 않고(남이 쓴 글이 다른 방문자에게 보이지 않게), 운영 설정을 바꾸지 못해요(누구나 가상 운영자로 들어와서요).
   */
  demoWide: boolean;
  /**
   * 시연 배포가 처음 뜰 때 켜 둘 운영 스위치(DESK_DEMO_SWITCHES, 11/4 사용자 결정). 시연 PGlite는 배포마다 비워져서 운영자가 켠 값이 사라지기 때문이에요.
   * 출시 기본값(LAUNCH_OPS_SETTINGS) 위에 이 스위치만 켜요. 고를 수 있는 것은 DEMO_SWITCHES뿐이에요(MCP처럼 바깥과 닿는 스위치는 넣지 않아요).
   */
  demoSwitches: DemoSwitch[];
  /**
   * 회사별 가상 근태 기록 파일(11/5, 회사별 분리 시험). 시연·개발에서만 DESK_MOCK_LEAVE_FILE로 읽어요.
   * 다른 회사(임시 IdP의 다른 영역)를 띄울 때 그 회사 가상 직원의 휴가 기록을 저장소 밖 파일에 둬요. 운영에서는 무시해요.
   */
  mockLeaveFile: string | undefined;
  /** 배포 시연용: 같은 근태 기록을 비밀 값(DESK_MOCK_LEAVE_JSON)으로 받아요. 파일보다 먼저예요. */
  mockLeaveJson: string | undefined;
  /**
   * 다른 가상 회사의 직원 명단(11/5, 회사별 분리 시연). 시연·개발에서만 DESK_MOCK_ROSTER_JSON으로 받아요.
   * 모의 로그인일 때 앱에 든 가상 직원 대신 이 명단을 써요. 운영에서는 무시해요.
   */
  mockRosterJson: string | undefined;
  /**
   * 시연 비밀번호(DESK_DEMO_PASSWORD, 10/30 Vercel 배포 회의). 넣으면 모의 로그인에 이 비밀번호가 있어야 들어와요.
   * 웹 화면만 Vercel(공개 주소)에 올린 시연에서 자료·API를 비밀번호 뒤에 둬요. 시연 배포에서만 써요.
   */
  demoPassword: string | undefined;
  /**
   * 앱 안 휴가 결재(문의함 휴가 요청 → 인사팀 승인·반려, ADR-24)를 켤지(DESK_LEAVE_IN_APP=true, 11/6 사용자 결정 A안).
   * 팀장 결재 단계가 없어서 운영(production)에서는 켤 수 없어요(설정 검사가 막아요). 개발·시험에서만 써요.
   * 끄면(기본) 휴가 신청·결재는 회사 그룹웨어 전자결재가 하고, 앱은 신청 전 카드와 승인 뒤 반영(근태 기록 읽기)만 해요.
   */
  leaveInApp: boolean;
}

const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** 실행 환경(시험에서 바꿔 넣어요) */
interface Runtime {
  node: string;
  execArgv: string[];
}

const NODE_ENVS = ['production', 'development', 'test'];
const MFA_POLICIES = ['off', 'always'] as const;
/** RFC 8176 값 중 두 번째 요소로 볼 것. SMS·전화는 넣지 않아요(정보보안팀). */
const DEFAULT_MFA_AMR = ['mfa', 'otp', 'hwk', 'swk'];
const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** AI 공급자(11/3): Anthropic·Gemini 둘 다 쓸 수 있고, 기본은 Anthropic이에요. 비우면 모델을 부르지 않는 fake예요. */
type AiProviderName = 'fake' | 'anthropic' | 'gemini';
const AI_PROVIDERS: readonly AiProviderName[] = ['fake', 'anthropic', 'gemini'];

/** 운영에서 받는 Anthropic 모델(BE-3). 목록 밖 값으로는 뜨지 않아요. */
const ALLOWED_AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
/** Gemini 모델 이름은 판마다 바뀌어서 목록을 박지 않고, 운영자가 계약한 모델을 DESK_AI_MODEL로 꼭 적게 해요. 모양만 검사해요. */
const GEMINI_MODEL_RE = /^gemini-[a-z0-9.-]{1,60}$/;

/** 공급자마다 기본 모델. Gemini는 기본값이 없어요(계약한 모델을 직접 적어요). */
function defaultModel(provider: AiProviderName): string {
  return provider === 'gemini' ? '' : 'claude-opus-5-5';
}

/** 모르는 값은 fake로 두고, 운영 설정 검사(productionProblems)가 이유를 말하며 막아요. */
function aiProviderOf(value: string | undefined): AiProviderName {
  return value === 'anthropic' || value === 'gemini' ? value : 'fake';
}

/** 운영에서 DESK_LEAVE_IN_APP=true를 거부하는 이유(11/6 사용자 결정, ADR-24 개정) */
export const LEAVE_IN_APP_BLOCKED = '앱 안 휴가 결재는 팀장 단계를 더하기 전까지 운영에서 켤 수 없어요';

const SECRET_MIN = 32;
/** 시연 비밀번호 최소 길이. 공개 주소에 올라가서 맞히기 어렵게 해요. */
const DEMO_PASSWORD_MIN = 12;

/**
 * 운영 설정이 실수하면 닫혀요(L-15). 값 하나만 빠지거나 개발용이어도 이유를 모두 말하고 뜨지 않아요.
 * 시연 배포(DESK_MOCK_LOGIN=true)는 회사 IdP·PostgreSQL 없이도 뜨지만, 비밀 값·주소 검사는 같아요.
 */
function productionProblems(env: NodeJS.ProcessEnv, config: ServerConfig, runtime: Runtime): string[] {
  const problems: string[] = [];
  const secretNames = ['SESSION_SECRET', 'PSEUDONYM_SECRET', 'PROPOSAL_SECRET', 'MCP_TOKEN_SECRET'];
  if (config.idp.kind === 'keycloak') secretNames.push('DESK_IDP_CLIENT_SECRET', 'DESK_IDP_DIRECTORY_CLIENT_SECRET');
  const given: string[] = [];
  for (const name of secretNames) {
    const value = env[name];
    if (!value) problems.push(`${name}이 없어요`);
    else if (/dev-only|change-me/i.test(value)) problems.push(`${name}이 개발용 값이에요`);
    else if (value.length < SECRET_MIN) problems.push(`${name}은 ${SECRET_MIN}자 이상이어야 해요`);
    else given.push(value);
  }
  if (new Set(given).size !== given.length) problems.push('비밀 값끼리는 서로 달라야 해요');
  if (!env.PUBLIC_BASE_URL?.startsWith('https://')) problems.push('PUBLIC_BASE_URL은 https 주소여야 해요');
  if (env.ANTHROPIC_LOG) problems.push('ANTHROPIC_LOG를 지워 주세요(요청 본문이 로그에 남을 수 있어요)');
  if (env.DESK_AI_PROVIDER && !(AI_PROVIDERS as readonly string[]).includes(env.DESK_AI_PROVIDER))
    problems.push(`DESK_AI_PROVIDER는 ${AI_PROVIDERS.filter((p) => p !== 'fake').join('·')} 중 하나이거나 비워야 해요`);
  if (config.aiProvider === 'anthropic' && !ALLOWED_AI_MODELS.includes(config.aiModel))
    problems.push(`DESK_AI_MODEL은 ${ALLOWED_AI_MODELS.join('·')} 중 하나여야 해요`);
  if (config.aiProvider === 'gemini' && !GEMINI_MODEL_RE.test(config.aiModel))
    problems.push('DESK_AI_PROVIDER=gemini이면 DESK_AI_MODEL에 계약한 Gemini 모델 이름(gemini-…)을 꼭 적어야 해요');
  // 키 없이 뜨면 묻기마다 모델 호출이 실패해서 규칙으로만 돌아요. 켠 줄 알았는데 꺼진 상태를 막아요(10/29 배포 준비 회의 B4).
  if (config.aiProvider === 'anthropic' && !env.ANTHROPIC_API_KEY) problems.push('DESK_AI_PROVIDER=anthropic인데 ANTHROPIC_API_KEY가 없어요');
  if (config.aiProvider === 'gemini' && !env.GEMINI_API_KEY) problems.push('DESK_AI_PROVIDER=gemini인데 GEMINI_API_KEY가 없어요');
  problems.push(...networkProblems(env, runtime));
  // 11/6 사용자 결정(A안): 앱 안 휴가 결재는 팀장 단계가 없어서 운영(시연 배포 포함)에서 켤 수 없어요. 개발·시험에서만 써요.
  if (env.DESK_LEAVE_IN_APP === 'true') problems.push(LEAVE_IN_APP_BLOCKED);
  if (config.demo) {
    // 시연 깃발이 운영 배포에 섞이면 가상 자료·모의 로그인이 실제 연결과 같이 떠요(QA-47). 시연은 다른 주소·DB·비밀로 따로 띄워요(CD-34).
    const real = [env.DESK_IDP && 'DESK_IDP', env.SLACK_BOT_TOKEN && 'SLACK_BOT_TOKEN'].filter((x): x is string => Boolean(x));
    if (real.length)
      problems.push(`시연 배포(DESK_MOCK_LOGIN=true)에 실제 연결 설정이 있어요(${real.join('·')}). 운영 배포에서는 DESK_MOCK_LOGIN을 지워 주세요`);
    const unknown = config.demoSwitches.filter((s) => !(DEMO_SWITCHES as readonly string[]).includes(s));
    if (unknown.length) problems.push(`DESK_DEMO_SWITCHES에는 ${DEMO_SWITCHES.join('·')}만 넣을 수 있어요(${unknown.join('·')})`);
    if (config.demoPassword !== undefined && config.demoPassword.length < DEMO_PASSWORD_MIN)
      problems.push(`DESK_DEMO_PASSWORD는 ${DEMO_PASSWORD_MIN}자 이상이어야 해요`);
    if (config.databaseUrl && env.DESK_DEMO_DATABASE !== 'true')
      problems.push('시연 배포가 DATABASE_URL을 써요. 시연 전용 DB가 맞으면 DESK_DEMO_DATABASE=true를 넣고, 운영 DB면 DESK_MOCK_LOGIN을 지워 주세요');
  } else {
    if (!config.databaseUrl) problems.push('DATABASE_URL이 없어요(운영은 PostgreSQL만 써요)');
    // 비우면 접속기록(ADR-20)의 접속지가 모두 관문 주소가 돼요. 관문 없이 직접 받는 구성이면 none을 적어서 일부러 정했다고 남겨요(B4).
    if (!env.TRUST_PROXY) problems.push('TRUST_PROXY가 없어요. 관문 주소를 넣고, 관문 없이 직접 받으면 none을 넣어 주세요(접속기록 접속지)');
    if (config.idp.kind !== 'keycloak') problems.push('DESK_IDP가 없어요(운영은 회사 IdP로만 로그인해요)');
    else if (!config.idp.issuer.startsWith('https://')) problems.push('DESK_IDP_ISSUER는 https 주소여야 해요');
    if (env.DESK_SEED_DEMO === 'true') problems.push('운영에는 가상 자료를 넣지 않아요. DESK_SEED_DEMO를 지워 주세요');
    if (env.DESK_DEMO_PASSWORD) problems.push('DESK_DEMO_PASSWORD는 시연 배포에만 넣어요. 운영 배포에서는 지워 주세요');
    if (env.DESK_DEMO_WIDE) problems.push('DESK_DEMO_WIDE는 시연 배포에만 넣어요. 운영 배포에서는 지워 주세요');
  }
  return problems;
}

/** 사내 망·관문 설정 검사(사내망·밖 접속 회의, 10/28). 틀리면 조용히 무시되거나 위조 IP를 믿는 값들이에요. */
function networkProblems(env: NodeJS.ProcessEnv, runtime: Runtime): string[] {
  const problems: string[] = [];
  // TRUST_PROXY에는 관문 주소만 넣어요. true는 위조한 X-Forwarded-For를 믿고, 숫자("1")는 0.0.0.1로 읽혀 아무도 믿지 않아요.
  const trust = list(env.TRUST_PROXY);
  if (env.TRUST_PROXY === 'true') problems.push('TRUST_PROXY=true는 위조한 접속 IP를 믿어요. 관문 주소만 넣어 주세요');
  else if (trust.some((t) => /^\d+$/.test(t))) problems.push('TRUST_PROXY에 숫자(단계 수)는 쓸 수 없어요. 관문 주소만 넣어 주세요');
  else if (trust.some((t) => ['loopback', 'linklocal', 'uniquelocal'].includes(t)))
    problems.push('TRUST_PROXY에 이름 대역은 너무 넓어요. 관문 주소만 넣어 주세요');
  else if (env.TRUST_PROXY !== 'none') {
    // 10.0.0.0/8처럼 넓은 대역이면 그 안의 직원 PC가 X-Forwarded-For를 꾸며 접속지를 바꿀 수 있어요(10/29 배포 준비 회의 B4).
    const wide = trust.filter((t) => {
      const bits = Number(t.match(/\/(\d+)$/)?.[1] ?? NaN);
      return Number.isFinite(bits) && bits < (t.includes(':') ? 64 : 24);
    });
    if (wide.length) problems.push(`TRUST_PROXY의 ${wide.join('·')}는 너무 넓어요(IPv4는 /24, IPv6는 /64까지). 관문 주소만 넣어 주세요`);
  }

  // 사내 프록시로 나가야 할 때: HTTPS_PROXY만 넣으면 Node가 조용히 무시해요(NODE_USE_ENV_PROXY=1 또는 --use-env-proxy가 있어야 해요).
  const proxyVars = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].filter((name) => env[name]);
  const proxyOn = env.NODE_USE_ENV_PROXY === '1' || [...runtime.execArgv, ...list(env.NODE_OPTIONS?.replace(/\s+/g, ','))].includes('--use-env-proxy');
  if (proxyVars.length && !proxyOn && env.NODE_USE_ENV_PROXY !== '0')
    problems.push(`${proxyVars[0]}이 있지만 Node가 쓰지 않아요. NODE_USE_ENV_PROXY=1을 넣거나, 일부러 끄려면 NODE_USE_ENV_PROXY=0을 넣어 주세요`);
  if (proxyVars.length && proxyOn && !nodeSupportsEnvProxy(runtime.node))
    problems.push(`Node ${runtime.node}는 NODE_USE_ENV_PROXY가 없어요(22.21 또는 24.0 이상)`);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') problems.push('NODE_TLS_REJECT_UNAUTHORIZED=0을 지워 주세요. 사내 인증서는 NODE_EXTRA_CA_CERTS로 믿게 해요');

  // 앱은 이 주소 뒤에 경로를 바로 이어 붙여요(OIDC 되돌아오기·MCP·링크). 주소 맨 위여야 해요.
  if (env.PUBLIC_BASE_URL?.startsWith('https://')) {
    try {
      const url = new URL(env.PUBLIC_BASE_URL);
      if (url.pathname !== '/' || env.PUBLIC_BASE_URL.endsWith('/') || url.search || url.hash)
        problems.push('PUBLIC_BASE_URL은 https://이름 모양이어야 해요(경로·끝 /·쿼리 없이)');
    } catch {
      problems.push('PUBLIC_BASE_URL을 주소로 읽지 못했어요');
    }
  }
  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_BASE_URL.startsWith('https://')) problems.push('ANTHROPIC_BASE_URL은 https 주소여야 해요');
  return problems;
}

/** NODE_USE_ENV_PROXY가 fetch에 들어온 판: 22.21 이상(22.x) 또는 24.0 이상 */
export function nodeSupportsEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, runtime: Runtime = { node: process.versions.node, execArgv: process.execArgv }): ServerConfig {
  // "prod"·"Production" 같은 값은 개발 모드로 떠서 모의 로그인이 열려요. 정해진 셋 말고는 뜨지 않아요(QA-47).
  if (env.NODE_ENV && !NODE_ENVS.includes(env.NODE_ENV)) throw new Error(`NODE_ENV는 ${NODE_ENVS.join('·')} 중 하나여야 해요`);
  const requireMfa = env.DESK_REQUIRE_MFA ?? 'off';
  if (!(MFA_POLICIES as readonly string[]).includes(requireMfa)) throw new Error(`DESK_REQUIRE_MFA는 ${MFA_POLICIES.join('·')} 중 하나여야 해요`);
  const production = env.NODE_ENV === 'production';
  const demo = !production || env.DESK_MOCK_LOGIN === 'true';
  // 운영 검사(productionProblems)가 빠진 값·개발용 값을 막아요. 개발은 아래 개발용 값을 써요.
  const secret = (name: string, devDefault: string) => env[name] || (production ? '' : devDefault);
  const config: ServerConfig = {
    // PORT는 미리보기 도구·호스팅이 웹 포트로 넘기는 경우가 있어서 서버는 SERVER_PORT를 따로 써요.
    port: Number(env.SERVER_PORT ?? 3190),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:5190',
    sessionSecret: secret('SESSION_SECRET', 'dev-only-session-secret-change-me-0000'),
    pseudonymSecret: secret('PSEUDONYM_SECRET', 'dev-only-pseudonym-secret-change-me-00'),
    proposalSecret: secret('PROPOSAL_SECRET', 'dev-only-proposal-secret-change-me-000'),
    mcpTokenSecret: secret('MCP_TOKEN_SECRET', 'dev-only-mcp-token-secret-change-me-000'),
    databaseUrl: env.DATABASE_URL || undefined,
    noRetentionContractConfirmed: env.NO_RETENTION_CONTRACT_CONFIRMED === 'true',
    aiProvider: aiProviderOf(env.DESK_AI_PROVIDER),
    aiModel: env.DESK_AI_MODEL ?? defaultModel(aiProviderOf(env.DESK_AI_PROVIDER)),
    seedDemo: env.DESK_SEED_DEMO ? env.DESK_SEED_DEMO === 'true' : demo,
    production,
    demo,
    migrateOnStart: env.DESK_MIGRATE_ON_START ? env.DESK_MIGRATE_ON_START === 'true' : demo,
    host: env.HOST || (production ? '0.0.0.0' : 'localhost'),
    trustProxy: !env.TRUST_PROXY || env.TRUST_PROXY === 'none' ? false : env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY,
    idp:
      env.DESK_IDP === 'keycloak'
        ? {
            kind: 'keycloak',
            issuer: env.DESK_IDP_ISSUER ?? 'http://localhost:8180/realms/one-line-desk',
            clientId: env.DESK_IDP_CLIENT_ID ?? 'one-line-desk-web',
            clientSecret: secret('DESK_IDP_CLIENT_SECRET', 'dev-only-idp-web-secret-change-me'),
            directoryClientId: env.DESK_IDP_DIRECTORY_CLIENT_ID ?? 'one-line-desk-directory',
            directoryClientSecret: secret('DESK_IDP_DIRECTORY_CLIENT_SECRET', 'dev-only-idp-directory-secret-change-me'),
          }
        : { kind: 'mock' },
    slackBotToken: env.SLACK_BOT_TOKEN || undefined,
    requireMfa: requireMfa as ServerConfig['requireMfa'],
    mfaAmr: env.DESK_IDP_MFA_AMR ? list(env.DESK_IDP_MFA_AMR) : DEFAULT_MFA_AMR,
    mfaAcr: list(env.DESK_IDP_MFA_ACR),
    acrValues: env.DESK_IDP_ACR_VALUES || undefined,
    webDist: env.DESK_WEB_DIST === 'none' ? undefined : env.DESK_WEB_DIST || (production ? DEFAULT_WEB_DIST : undefined),
    build: env.DESK_BUILD || 'dev',
    demoWide: demo && env.DESK_DEMO_WIDE === 'true',
    demoSwitches: demo ? (list(env.DESK_DEMO_SWITCHES) as DemoSwitch[]) : [],
    mockLeaveFile: demo ? env.DESK_MOCK_LEAVE_FILE || undefined : undefined,
    mockLeaveJson: demo ? env.DESK_MOCK_LEAVE_JSON || undefined : undefined,
    mockRosterJson: demo ? env.DESK_MOCK_ROSTER_JSON || undefined : undefined,
    demoPassword: demo ? env.DESK_DEMO_PASSWORD || undefined : undefined,
    leaveInApp: env.DESK_LEAVE_IN_APP === 'true',
  };
  // 응답 머리에 그대로 실어서 글자를 좁혀 둬요.
  if (!BUILD_ID.test(config.build)) throw new Error('DESK_BUILD는 영문·숫자·.·_·- 64자까지예요');
  if (production) {
    const problems = productionProblems(env, config, runtime);
    if (problems.length) throw new Error(`운영 설정을 확인해 주세요:\n- ${problems.join('\n- ')}`);
  }
  return config;
}
