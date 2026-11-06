-- 읽기 전용 MCP(ADR-15). 10/30: 옛 001의 mcp_grants와 500을 한 파일로 합쳤어요. 11/2: 520(CLI 연결·기기별 승인)도 합쳤어요.
-- 11/6: 530(월간 보고용 날마다 셈)도 합쳤어요(최종 구조는 같아요).

-- 등록 클라이언트. 동적 등록은 없어요. 운영자가 보안팀 승인 목록에 오른 클라이언트만 넣어요.
-- 허용 두 겹(M2): 기술 = 등록된 ID(·비밀)·리디렉트 URI, 정책 = security_approved(회사 명의 무보관 조건 확인).
-- demo_only는 시연용 가상 클라이언트예요. 데이터가 모두 모의(등급 0)일 때만 허용 목록 안으로 봐요.
-- public_client(11/2, ADR-15 개정): 비밀이 없고(token_endpoint_auth_method none) PKCE로만 지키는 CLI(Claude Code·Codex)예요.
--   리디렉트는 루프백(localhost·127.0.0.1·[::1])만이고 포트는 상관없이 받아요(RFC 8252 §7.3, 서버 코드가 검사해요).
create table mcp_clients (
  client_id text primary key check (client_id ~ '^[A-Za-z0-9._-]{8,100}$'),
  client_secret_hash text check (char_length(client_secret_hash) = 64),
  app_name text not null check (char_length(app_name) between 1 and 40),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  security_approved boolean not null default false,
  demo_only boolean not null default false,
  created_at timestamptz not null default now(),
  public_client boolean not null default false,
  constraint mcp_clients_secret_shape check (
    (public_client and client_secret_hash is null) or (not public_client and client_secret_hash is not null)
  )
);

-- 승인. 기기(갱신 토큰 계열)마다 하나예요(U6): 같은 사람이 같은 앱을 노트북·데스크톱에서 붙여도 서로 끊지 않아요.
-- [끊기]는 그 앱의 모든 기기, 클라이언트 폐기(RFC 7009)는 그 기기만 지워요. 모든 기기 로그아웃·퇴사 확인은 전부 지워요.
-- "마지막 사용"은 남기지 않아요. connected_at은 한 사람 × 한 앱의 기기 수 상한을 넘을 때 가장 먼저 연결한 기기를 고르는 데만 써요.
-- grant_id: 접근 토큰이 이 값을 들고 있어서 요청마다 폐기 여부를 확인해요.
create table mcp_grants (
  pseudonym_id text not null,
  client_id text not null,
  scopes text[] not null,
  connected_on date not null default current_date,
  refresh_token_hash text not null,
  grant_id uuid not null default gen_random_uuid(),
  connected_at timestamptz not null default now(),
  constraint mcp_grants_pkey primary key (grant_id),
  constraint mcp_grants_client_fk foreign key (client_id) references mcp_clients (client_id) on delete cascade
);
create unique index mcp_grants_refresh_token_hash on mcp_grants (refresh_token_hash);
create index mcp_grants_person_client on mcp_grants (pseudonym_id, client_id);

-- MCP 월간 보고용 날마다 셈(11/3 사용자 결정, ADR-21 예외 · ADR-15 관리 평면 1단계).
-- 감사 로그는 7일만 남아서(ADR-21) 달 보고를 감사 로그로 셀 수 없어요. 그래서 감사 로그를 남기는 그 자리에서 셈만 +1 해요.
-- 칸: 날(한국 시간)·종류(정해진 코드)·앱 이름(운영자가 등록한 이름, 모르면 '-')·수. 사람·가명 ID·클라이언트 ID·도구 입력 칸은 없어요.
-- 13개월(이번 달 + 지난 12달)이 지난 날은 mcp 모듈 retention이 한 시간마다 지워요. 코드 목록은 modules/mcp/counts.ts와 같아요.
create table mcp_daily_counts (
  day date not null,
  kind text not null check (
    kind in (
      'call.found',
      'call.none',
      'call.refused',
      'call.error',
      'connect',
      'connect.denied',
      'disconnect',
      'disconnect.ops',
      'token.refused',
      'authorize.blocked',
      'employment.ended'
    )
  ),
  app text not null check (char_length(app) between 1 and 40),
  count integer not null check (count >= 0),
  constraint mcp_daily_counts_pkey primary key (day, kind, app)
);
