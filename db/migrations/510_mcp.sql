-- 읽기 전용 MCP(ADR-15). 10/30: 옛 001의 mcp_grants와 500을 한 파일로 합쳤어요.

-- 등록 클라이언트. 동적 등록은 없어요. 운영자가 보안팀 승인 목록에 오른 기밀 클라이언트만 넣어요.
-- 허용 두 겹(M2): 기술 = 등록된 ID·비밀·정확한 리디렉트 URI, 정책 = security_approved(회사 명의 무보관 조건 확인).
-- demo_only는 시연용 가상 클라이언트예요. 데이터가 모두 모의(등급 0)일 때만 허용 목록 안으로 봐요.
create table mcp_clients (
  client_id text primary key check (client_id ~ '^[A-Za-z0-9._-]{8,100}$'),
  client_secret_hash text not null check (char_length(client_secret_hash) = 64),
  app_name text not null check (char_length(app_name) between 1 and 40),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  security_approved boolean not null default false,
  demo_only boolean not null default false,
  created_at timestamptz not null default now()
);

-- 승인. [끊기]·모든 기기 로그아웃·퇴사 확인 때 바로 지워요. "마지막 사용"은 남기지 않아요.
-- grant_id: 접근 토큰이 이 값을 들고 있어서 요청마다 폐기 여부를 확인해요.
create table mcp_grants (
  pseudonym_id text not null,
  client_id text not null,
  scopes text[] not null,
  connected_on date not null default current_date,
  refresh_token_hash text not null,
  grant_id uuid not null default gen_random_uuid(),
  primary key (pseudonym_id, client_id),
  constraint mcp_grants_client_fk foreign key (client_id) references mcp_clients (client_id) on delete cascade
);
create unique index mcp_grants_refresh_token_hash on mcp_grants (refresh_token_hash);
