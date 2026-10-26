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
