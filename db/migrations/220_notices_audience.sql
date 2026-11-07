-- 새 공지 알림 대상(11/6 사용자 요청, ADR-09 개정·ADR-16 보강). 새 공지 사본마다 AI(또는 규칙)가 제안한 대상 조건과 확인 상태를 둬요.
-- 사람 칸은 없어요: 누가 확인했는지·누구에게 갔는지는 남기지 않고(감사 로그에 동작·결과·수만), 받은 사람은 알림 표에만 있어요.
-- 조건은 부서·층·역할 이름과 "모두"뿐이고, 근거(evidence)는 공지 글에 그대로 있는 짧은 말(최대 3개, 20자)만이에요. 공지 본문은 여전히 두지 않아요.
-- 7일(RECORD_KEEP_DAYS) 지나면 notices 모듈 retention이 지워요(created_at 인덱스).
create table notice_audience (
  id bigserial primary key,
  notice_id text not null unique references notices (id) on delete cascade,
  everyone boolean not null,
  departments text[] not null default '{}',
  floors text[] not null default '{}',
  roles text[] not null default '{}' check (roles <@ array['team-lead', 'facilities']::text[]),
  evidence text[] not null default '{}' check (cardinality(evidence) <= 3),
  by_model boolean not null,
  state text not null default 'pending' check (state in ('pending', 'sent', 'skipped')),
  -- 자동 보내기 스위치로 확인 없이 보냈는지
  auto boolean not null default false,
  sent_count integer check (sent_count is null or sent_count >= 0),
  created_at timestamptz not null,
  decided_at timestamptz,
  constraint notice_audience_everyone check (not everyone or (cardinality(departments) = 0 and cardinality(floors) = 0 and cardinality(roles) = 0)),
  constraint notice_audience_decided check ((state = 'pending') = (decided_at is null))
);
create index notice_audience_created on notice_audience (created_at);
