-- 담당 안내(ADR-09). 10/30: 옛 001의 navi 표와 101·102를 한 파일로 합쳤어요.
-- 사람 이름 칸은 없어요(가져오기에서 버려요, D9).

-- 분장표 행. desk_url: [창구 열기]·IT 헬프데스크 링크가 여기서 와요.
create table navi_rows (
  id text primary key,
  task text not null,
  team text not null,
  desk text not null,
  next_step text not null,
  processing_period text,
  aliases text[] not null default '{}',
  revised_on date not null,
  owner_department text not null,
  desk_url text,
  constraint navi_rows_desk_url_scheme check (desk_url is null or desk_url ~ '^(https?://|mailto:)')
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
-- S5 기록 묶음은 예측 행으로 모아요.
create index navi_feedback_predicted_row on navi_feedback (predicted_row);

-- 담당 팀에 문의 보내기(10/26, ADR-16).
-- 사람이 확인 시트에서 [보내기]를 누른 글만 저장해요. 묻기(검색) 문장과 달리 받는 팀이 읽어야 하는 글이에요.
-- 받는 곳은 사람이 아니라 분장표 행의 주인 부서예요(D9: 담당자 이름은 없어요). 7일이 지나면 지워요(ADR-21).
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
