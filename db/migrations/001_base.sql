-- 한 줄 데스크 기본 표(초안). 칸은 docs/ADR.md를 따라요.
-- 원칙: 질문 원문·사람 이름·투표자를 다시 잇는 칸을 두지 않아요. 사람은 가명 ID(p_…)로만 남아요.

create extension if not exists btree_gist;

-- 감사 로그(ADR-10, R11, M5). 내용 칸은 없어요.
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  pseudonym_id text not null,
  channel text not null check (channel in ('ask', 'write', 'mcp', 'auth', 'ops')),
  module text,
  action text,
  tool text,
  client_id text,
  plan_id uuid,
  result text not null
);
create index audit_log_at on audit_log (at);

-- 쓰기 경계(ADR-03). 매개변수는 검증된 구조 값만 담고 자유 문장은 넣지 않아요.
create table plans (
  id uuid primary key,
  pseudonym_id text not null,
  module text not null check (module in ('navi', 'notices', 'rooms', 'pantry')),
  action text not null,
  params jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state text not null default 'proposed' check (state in ('proposed', 'executing', 'done', 'blocked', 'expired', 'cancelled')),
  result_ref text
);

-- 회의실(ADR-06). 모의 장부가 원본이고, 같은 방·겹치는 시간은 DB가 막아요.
create table rooms (
  id text primary key,
  name text not null,
  floor text not null,
  capacity integer not null check (capacity > 0),
  equipment text[] not null default '{}'
);

create table room_reservations (
  id bigserial primary key,
  room_id text not null references rooms (id),
  slot tstzrange not null check (not isempty(slot)),
  pseudonym_id text not null,
  plan_id uuid not null unique,
  created_at timestamptz not null default now(),
  exclude using gist (room_id with =, slot with &&)
);

-- 취소한 예약은 여기로 옮겨요. 그래서 겹침 제약에 조건을 달지 않아요.
create table room_reservation_history (
  id bigint primary key,
  room_id text not null,
  slot tstzrange not null,
  pseudonym_id text not null,
  plan_id uuid not null,
  created_at timestamptz not null,
  cancelled_at timestamptz not null default now()
);

-- 같이 채워요(ADR-07). 표는 원 요청 카드에 붙고, 합치기는 투표 행을 바꾸지 않아요.
create table pantry_cycles (
  floor text not null,
  cycle_no integer not null,
  state text not null default 'open' check (state in ('open', 'closed')),
  per_person_limit integer not null check (per_person_limit > 0),
  primary key (floor, cycle_no)
);

create table pantry_cards (
  id bigserial primary key,
  floor text not null,
  item_name text not null check (char_length(item_name) between 1 and 60),
  catalog_item_id text,
  author_pseudonym_id text not null,
  state text not null default 'open' check (state in ('open', 'ordered')),
  bundle_version integer not null default 0,
  created_at timestamptz not null default now()
);

create table pantry_votes (
  pseudonym_id text not null,
  card_id bigint not null references pantry_cards (id),
  created_at timestamptz not null default now(),
  primary key (pseudonym_id, card_id)
);

create table pantry_merges (
  id bigserial primary key,
  merged_card_id bigint not null references pantry_cards (id),
  representative_card_id bigint not null references pantry_cards (id),
  facilities_pseudonym_id text not null,
  merged_at timestamptz not null default now(),
  reverted_at timestamptz,
  check (merged_card_id <> representative_card_id)
);

create table pantry_similar_flags (
  card_a bigint not null references pantry_cards (id),
  card_b bigint not null references pantry_cards (id),
  source text not null check (source in ('ai', 'rule')),
  state text not null default 'showing' check (state in ('showing', 'merged', 'kept-apart')),
  primary key (card_a, card_b),
  check (card_a < card_b)
);

-- 담당 안내(ADR-09). 사람 이름 칸은 없어요(가져오기에서 버려요).
create table navi_rows (
  id text primary key,
  task text not null,
  team text not null,
  desk text not null,
  next_step text not null,
  processing_period text,
  aliases text[] not null default '{}',
  revised_on date not null,
  owner_department text not null
);

-- "틀렸어요" 기록(R8). 사용자 ID·가명 ID·질문 원문은 없어요.
create table navi_feedback (
  id bigserial primary key,
  predicted_kind text not null,
  corrected_kind text,
  predicted_row text,
  chosen_row text,
  reason_code text not null check (reason_code in ('other-owner', 'not-listed', 'content-changed', 'wrong-kind')),
  at timestamptz not null default now()
);

-- MCP 승인(ADR-15). [끊기]·모든 기기 로그아웃·퇴사 확인 때 바로 지워요. "마지막 사용"은 남기지 않아요.
create table mcp_grants (
  pseudonym_id text not null,
  client_id text not null,
  scopes text[] not null,
  connected_on date not null default current_date,
  refresh_token_hash text not null,
  primary key (pseudonym_id, client_id)
);

-- 다음에 할 것: /ask·/pantry/draft 경로의 DB 역할은 판 표 INSERT·UPDATE 권한을 갖지 않게 나눠요(ADR-04).
-- 운영자 읽기 역할은 pantry_votes·mcp_grants.refresh_token_hash를 읽지 못하게 해요(ADR-10).
