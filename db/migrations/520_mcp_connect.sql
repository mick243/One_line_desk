-- MCP 연결 넓히기(11/2, ADR-15 개정). CLI(Claude Code·Codex)가 비밀 없이 붙고, 기기마다 승인이 따로 있어요.

-- 공개 클라이언트: 비밀이 없고(token_endpoint_auth_method none) PKCE로만 지켜요. 운영자가 미리 등록한 것만 받아요(동적 등록·CIMD 없음).
-- 리디렉트 주소는 루프백(localhost·127.0.0.1·[::1])만이고, 포트는 상관없이 받아요(RFC 8252 §7.3, 서버 코드가 검사해요).
alter table mcp_clients
  alter column client_secret_hash drop not null,
  add column public_client boolean not null default false,
  add constraint mcp_clients_secret_shape check (
    (public_client and client_secret_hash is null) or (not public_client and client_secret_hash is not null)
  );

-- 기기별 승인(U6): 같은 사람이 같은 앱을 노트북·데스크톱에서 붙여도 서로 끊지 않아요. 승인 ID가 한 기기(갱신 토큰 계열)예요.
-- [끊기]는 그 앱의 모든 기기를 지우고, 클라이언트 폐기(RFC 7009)는 그 기기만 지워요.
-- 한 사람 × 한 앱의 기기는 서버가 정한 수까지만 두고, 넘치면 가장 먼저 연결한 기기를 지워요. connected_at은 그 순서를 정하는 데만 써요.
alter table mcp_grants drop constraint mcp_grants_pkey;
alter table mcp_grants add primary key (grant_id);
alter table mcp_grants add column connected_at timestamptz not null default now();
create index mcp_grants_person_client on mcp_grants (pseudonym_id, client_id);
