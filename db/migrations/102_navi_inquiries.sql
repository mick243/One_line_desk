-- 담당 팀에 문의 보내기(10/26, ADR-16).
-- 사람이 확인 시트에서 [보내기]를 누른 글만 저장해요. 묻기(검색) 문장과 달리 받는 팀이 읽어야 하는 글이에요.
-- 받는 곳은 사람이 아니라 분장표 행의 주인 부서예요(D9: 담당자 이름은 없어요). 90일이 지나면 지워요.
create table navi_inquiries (
  id bigserial primary key,
  row_id text references navi_rows (id) on delete set null,
  -- 보낼 때의 업무 이름과 담당 팀. 행이 바뀌어도 받은 문의가 읽히게 같이 남겨요.
  task text not null,
  team text not null,
  department text not null,
  sender_pseudonym text not null,
  -- 받는 팀이 답하려면 누구인지 알아야 해요. 보내기 전 확인 시트에서 "내 이름·부서가 같이 가요"라고 알려요.
  sender_name text not null,
  sender_department text not null,
  question text not null check (char_length(question) between 1 and 1000),
  reason text not null check (char_length(reason) between 1 and 500),
  state text not null default 'new' check (state in ('new', 'seen', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index navi_inquiries_department on navi_inquiries (department, created_at desc);
create index navi_inquiries_sender on navi_inquiries (sender_pseudonym, created_at desc);
