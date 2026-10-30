-- 한 줄 데스크 공통 표. 칸은 docs/ADR.md를 따라요.
-- 원칙: 질문 원문·사람 이름·투표자를 다시 잇는 칸을 두지 않아요. 사람은 가명 ID(p_…)로만 남아요.
-- 10/30: 옛 001~006을 한 파일로 합쳤어요(파일럿 DB 전 한 번만, docs/CONVENTIONS.md). 모듈 표는 각 모듈 파일로 옮겼어요.

-- 회의실·장비의 같은 칸 겹침 제약(exclude using gist)에 써요.
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
-- result: plan 결과 카드(JSON). 같은 plan_id 확인이 다시 와도 결과만 돌려줘요.
create table plans (
  id uuid primary key,
  pseudonym_id text not null,
  module text not null check (module in ('navi', 'notices', 'rooms', 'pantry')),
  action text not null,
  params jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state text not null default 'proposed' check (state in ('proposed', 'executing', 'done', 'blocked', 'expired', 'cancelled')),
  result_ref text,
  result jsonb
);

-- 쓰기 영수증(멱등 키, ADR-03). 같은 키가 다시 오면 저장한 결과만 돌려줘요.
create table action_receipts (
  idempotency_key text primary key,
  pseudonym_id text not null,
  module text not null,
  action text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

-- AI 비용 집계(본문 없음, ADR-10 운영 표).
create table ai_usage (
  id bigserial primary key,
  at timestamptz not null default now(),
  module text not null,
  purpose text not null,
  provider text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  ok boolean not null
);

-- 앱 안 알림(10/26, ADR-16). 받는 쪽은 한 사람(가명 ID) 또는 한 부서예요.
-- 알림 글에는 내용(문의 글 등)을 넣지 않고, 무슨 일인지와 어느 페이지를 보면 되는지만 넣어요(R12와 같은 뜻).
create table notifications (
  id bigserial primary key,
  audience_pseudonym text,
  audience_department text,
  -- 부서 알림에서 빼는 사람(보낸 사람이 같은 부서일 때)
  exclude_pseudonym text,
  module text not null check (module in ('navi', 'notices', 'rooms', 'pantry', 'core')),
  title text not null check (char_length(title) between 1 and 120),
  page text not null check (page in ('home', 'navi', 'rooms', 'notices', 'board', 'mine', 'ops', 'chart')),
  created_at timestamptz not null default now(),
  check ((audience_pseudonym is null) <> (audience_department is null))
);
create index notifications_person on notifications (audience_pseudonym, created_at desc);
create index notifications_department on notifications (audience_department, created_at desc);

-- 읽음은 사람마다 따로예요(부서 알림도 사람마다 읽어요).
create table notification_reads (
  notification_id bigint not null references notifications (id) on delete cascade,
  pseudonym_id text not null,
  read_at timestamptz not null default now(),
  primary key (notification_id, pseudonym_id)
);

-- 모의 그룹웨어 캘린더·모의 Slack(10/26, ADR-17). 실제 서비스 대신 시연에서 무엇이 나갔는지 보여 줘요.
-- 가상 직원 메일만 들어가요. 실제 그룹웨어·Slack 어댑터를 쓰면 이 표는 비어 있어요.
create table mock_calendar_events (
  uid text primary key,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text not null,
  organizer_email text not null,
  attendee_emails text[] not null default '{}',
  cancelled boolean not null default false,
  updated_at timestamptz not null
);

create table mock_messenger_messages (
  id bigserial primary key,
  to_email text not null,
  text text not null,
  sent_at timestamptz not null
);
create index mock_messenger_messages_to on mock_messenger_messages (to_email, sent_at desc);

-- 운영 설정(ADR-12, L-14). 운영자가 바꾼 스위치·값을 저장해서 서버를 다시 켜도 그대로예요(QA-33).
-- 한 줄만 있어요. 바꾼 칸만 저장하고, 없는 칸은 서버의 기본값(개발·시연 또는 출시 기본값)을 써요.
create table ops_settings (
  id smallint primary key default 1 check (id = 1),
  overrides jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 접속기록(10/28, ADR-20). 개인정보의 안전성 확보조치 기준 제8조: 누가·언제·어디서(접속지)·무엇을·누구의 정보를 처리했는지 남겨요.
-- 감사 로그(audit_log)와 따로예요. 감사 로그는 내용 없이 동작 종류만, 여기는 법이 요구하는 접속지(IP)와 처리한 정보주체 표시(가명 ID·문의 번호)를 남겨요.
-- 글·검색어·이름은 넣지 않아요(core/access-record.ts가 정해진 칸만 받아요). 고칠 수 없고, 보관 기간(1년)이 지난 줄만 지울 수 있어요.
-- 운영 DB에서는 앱 계정에 INSERT·SELECT와 1년 지난 줄 DELETE만 줘요(L-21). 아래 트리거는 그 권한과 따로 한 번 더 막아요.
create table access_log (
  id bigserial primary key,
  at timestamptz not null,
  pseudonym_id text not null,
  action text not null,
  subject_refs text[] not null default '{}',
  client_ip inet,
  request_id text
);
create index access_log_at on access_log (at);
create index access_log_who on access_log (pseudonym_id, at);

create function access_log_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'access log rows cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  if old.at > now() - interval '365 days' then
    raise exception 'access log rows are kept for a year' using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

create trigger access_log_no_change
  before update or delete on access_log
  for each row execute function access_log_guard();

-- 다음에 할 것: /ask·/pantry/draft 경로의 DB 역할은 판 표 INSERT·UPDATE 권한을 갖지 않게 나눠요(ADR-04).
-- 운영자 읽기 역할은 pantry_votes·mcp_grants.refresh_token_hash를 읽지 못하게 해요(ADR-10).
