-- 운영 설정(ADR-12, L-14). 운영자가 바꾼 스위치·값을 저장해서 서버를 다시 켜도 그대로예요(QA-33).
-- 한 줄만 있어요. 바꾼 칸만 저장하고, 없는 칸은 서버의 기본값(개발·시연 또는 출시 기본값)을 써요.
create table ops_settings (
  id smallint primary key default 1 check (id = 1),
  overrides jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);
