-- 담당 안내(ADR-09). 10/30: 옛 001의 navi 표와 101·102를 한 파일로 합쳤어요.
-- 11/2: 120(휴가 요청)·130(행 출처)·140(온보딩 주차)·150(문의 주간 셈)·160(IT FAQ)·170(공가)를 이 파일로 합쳤어요.
-- 11/6: 120(병가)·130(보관 회차 인덱스)·140(자리비움)을 이 파일로 합쳤어요(최종 구조는 같아요).
-- 사람 이름 칸은 없어요(가져오기에서 버려요, D9).

-- 분장표 행. desk_url: [창구 열기]·IT 헬프데스크 링크가 여기서 와요.
-- source: 가상 분장표(seed)는 demo, 분장표 주인이 S5로 반영한 행은 upload예요. upload 행이 하나라도 있으면 "시연 데이터" 띠와
--   MCP 모의 자료 판정(allMockData)이 거짓이 돼요. 기본값을 upload로 둬서 출처를 모르면 실제 자료로 봐요(잠금이 닫히는 쪽).
-- onboarding_week: 신규 입사자 첫 2주 할 일(1·2, 비어 있으면 아님). 분장표 주인이 S5 파일로 관리해요. 진행은 저장하지 않아요(ADR-21).
-- 기준 자료라 7일 지우기 대상이 아니에요.
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
  source text not null default 'upload' check (source in ('demo', 'upload')),
  onboarding_week smallint check (onboarding_week is null or onboarding_week in (1, 2)),
  constraint navi_rows_desk_url_scheme check (desk_url is null or desk_url ~ '^(https?://|mailto:)')
);

-- 받는 곳을 바꿔 보낸 기록(옛 "틀렸어요", R8·ADR-26). 사용자 ID·가명 ID·질문 원문은 없어요.
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
-- 보관 회차(11/3, ADR-21 개정): 7일 지난 기록을 at로 찾아요.
create index navi_feedback_at on navi_feedback (at);

-- 담당 팀에 문의 보내기(10/26, ADR-16).
-- 사람이 확인 시트에서 [보내기]를 누른 글만 저장해요. 묻기(검색) 문장과 달리 받는 팀이 읽어야 하는 글이에요.
-- 받는 곳은 사람이 아니라 분장표 행의 주인 부서예요(D9: 담당자 이름은 없어요). 7일이 지나면 지워요(ADR-21).
-- 휴가 요청(10/30, ADR-24): kind = 'leave'. 승인된 휴가는 우리 DB가 아니라 인사 근태 기록(어댑터)에 들어가요. 연차 숫자는 저장하지 않아요(ADR-18).
--   leave_days: 쓸 날 [{date, kind}]. sender_subject: 보낸 사람 IdP 주체(받은 팀이 남은 연차를 계산하고 승인 때 근태 기록에 넣으려고 써요.
--   화면·LLM에는 내보내지 않아요). leave_recorded: 승인했을 때 근태 기록에 넣었는지(근태 연결 안 함이면 false).
-- 공가(11/1): leave_type(annual·official·sick)과 공가 사유 코드. 공가는 연차에서 빠지지 않고, 승인하면 근태 기록에 공가로 들어가요.
-- 병가(11/3, ADR-24 개정, docs/병가준비_2026-11-01.md): sick_reason_code는 정해진 선택지만 받아요(자유 글·병명·증상 칸 없음, 사용자 결정 1).
--   unwell(몸이 안 좋아요)·clinic(병원 진료)·family(가족 돌봄). 병가도 연차에서 빠지지 않고 쓴 날 수는 저장하지 않아요(ADR-18).
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
  state text not null default 'new' check (state in ('new', 'seen', 'done', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  kind text not null default 'general' check (kind in ('general', 'leave')),
  leave_days jsonb,
  sender_subject text,
  decision_reason text check (decision_reason is null or char_length(decision_reason) between 1 and 500),
  leave_recorded boolean,
  leave_type text,
  leave_reason_code text check (leave_reason_code in ('reserve', 'vote', 'summons', 'duty')),
  sick_reason_code text check (sick_reason_code in ('unwell', 'clinic', 'family')),
  constraint navi_inquiries_leave_shape check (
    (kind = 'leave' and leave_days is not null and sender_subject is not null)
    or (kind = 'general' and leave_days is null and sender_subject is null)
  ),
  -- 반려는 사유가 있어야 해요. 승인·반려는 휴가 요청만이에요.
  constraint navi_inquiries_decision_shape check (
    (state = 'rejected' and decision_reason is not null and kind = 'leave')
    or (state = 'approved' and kind = 'leave' and decision_reason is null)
    or (state in ('new', 'seen', 'done') and decision_reason is null)
  ),
  -- leave_type 값 검사도 이 모양 검사 하나가 해요. 공가 사유는 공가일 때만, 병가 사유는 병가일 때만 있어요(둘 다 그때는 꼭 있어요).
  -- check는 결과가 null이면 통과라서 휴가 요청은 leave_type is not null을 맨 앞에 둬요.
  constraint navi_inquiries_leave_type_shape check (
    case kind
      when 'leave' then leave_type is not null
        and leave_type in ('annual', 'official', 'sick')
        and (leave_type = 'official') = (leave_reason_code is not null)
        and (leave_type = 'sick') = (sick_reason_code is not null)
      else leave_type is null and leave_reason_code is null and sick_reason_code is null
    end
  )
);
create index navi_inquiries_department on navi_inquiries (department, created_at desc);
create index navi_inquiries_sender on navi_inquiries (sender_pseudonym, created_at desc);
-- 보관 회차(11/3, ADR-21 개정): 문의는 한 시간 보관 회차에서만 지워요. 앞 칸이 부서·보낸 사람인 위 인덱스로는 7일 지난 행을 못 찾아요.
create index navi_inquiries_created on navi_inquiries (created_at);

-- 받은 팀의 답장(10/30, ADR-24). 답장한 사람(받은 팀) 이름이 보낸 사람 화면에 보여요. 7일이 지나면 지워요(ADR-21).
create table navi_inquiry_replies (
  id bigserial primary key,
  inquiry_id bigint not null references navi_inquiries (id) on delete cascade,
  author_pseudonym text not null,
  author_name text not null,
  body text not null check (char_length(body) between 1 and 1000),
  request_id text not null,
  created_at timestamptz not null default now(),
  unique (inquiry_id, request_id)
);
create index navi_inquiry_replies_inquiry on navi_inquiry_replies (inquiry_id, created_at);
create index navi_inquiry_replies_created on navi_inquiry_replies (created_at);

-- 부서 간 문의 처리 셈(10/31 넓힐 후보 ④, 사용자 결정: 받은 부서 주간 건수 · 7일 보관).
-- 문의가 보관 기간(7일)이 지나 지워지는 순간에, 지우는 문의를 보낸 주(ISO 주, 한국 시간) × 받은 부서로 세어 더해요.
-- 사람(보낸 사람·받은 사람)·글·행 ID·보낸 부서 칸은 없어요. 화면은 10건 이상인 칸만 보여 줘요.
-- 셈 행도 기록이라 마지막으로 더한 뒤 7일이 지나면 지워요(ADR-21).
create table navi_inquiry_weeks (
  week text not null check (week ~ '^[0-9]{4}-W[0-9]{2}$'),
  department text not null,
  sent int not null check (sent >= 0),
  handled int not null check (handled >= 0),
  expired_open int not null check (expired_open >= 0),
  updated_at timestamptz not null,
  primary key (week, department),
  check (handled + expired_open = sent)
);
create index navi_inquiry_weeks_updated on navi_inquiry_weeks (updated_at);

-- IT FAQ(10/31 넓힐 후보 ②). 붙여 넣은 IT 오류 문장에 맞는 FAQ를 찾아 원문 단계를 그대로 보여 줘요.
-- 기준 자료라 7일 지우기 대상이 아니에요. 사람 이름 칸은 없어요. 붙여 넣은 오류 문장은 어디에도 저장하지 않아요(ADR-10).
-- row_id: 해결이 안 될 때 문의를 보내는 분장표 행(IT지원팀). source는 분장표와 같은 뜻이에요(demo/upload).
create table navi_it_faqs (
  id text primary key check (id ~ '^ITF-[0-9]{2,3}$'),
  title text not null check (char_length(title) between 1 and 80),
  aliases text[] not null default '{}',
  error_codes text[] not null default '{}',
  steps text[] not null check (cardinality(steps) between 1 and 12),
  revised_on date not null,
  row_id text references navi_rows (id) on delete set null,
  source text not null default 'upload' check (source in ('demo', 'upload'))
);

-- 자리비움(11/3 사용자 결정, 홈 채팅 "같은 팀 일정"). 직원이 자기 외근·출장·재택·자리비움을 알려요.
-- 칸은 가명 ID·종류 코드·시작·끝뿐이에요. 자유 글(사유·장소)·이름·부서 칸은 없어요(보여 줄 때 디렉터리로 찾아요).
-- 정하기·지우기는 본인만, 고정 버튼(ctx.fixed.run)으로만 해요. 같은 부서 사람에게만 홈 채팅으로 보여요.
-- 기록 보관 7일(ADR-21): 정한 지 7일 지난 줄과 끝난 지 7일 지난 줄을 한 시간 보관 회차가 지워요(navi 모듈 retention).
create table navi_away (
  id bigserial primary key,
  pseudonym_id text not null,
  kind text not null check (kind in ('outside', 'trip', 'remote', 'away')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint navi_away_range check (ends_at > starts_at and ends_at - starts_at <= interval '8 days')
);
create index navi_away_who on navi_away (pseudonym_id, starts_at);
create index navi_away_created on navi_away (created_at);
create index navi_away_ends on navi_away (ends_at);
