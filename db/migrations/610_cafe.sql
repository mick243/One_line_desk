-- 사내 카페 주문(11/6 사용자 결정, PRD F4·ADR-29, 출시 기본 끔). 공통 표 제약(모듈 cafeteria·알림)은 010_core.sql에 있어요.
-- 11/6: 1묶음(주문 → 카페 판 → 건네기)·620(2묶음: 청구·입금 확인·한 달 한도·미납 막기·알림·보관·총무 정산)·630(3묶음: [못 받았어요])을
--   이 파일 하나로 합쳤어요(최종 구조는 같아요).
-- 원칙: 주문 문장·자유 글 칸은 없어요(옵션은 메뉴가 정한 이름만, 그 밖엔 금액·입금 코드뿐). 사람은 가명 ID(p_…)로만 남고 이름은 넣지 않아요.
--   총무 정산 화면이 열릴 때 IdP 주체로 디렉터리에서 이름을 그때 붙여요.
-- 금액은 서버가 메뉴 직원가 × 수량으로 계산해서 주문 행에 남겨요(AI는 금액을 만들지도 보지도 않아요).
-- 앱은 돈을 받거나 보내지 않아요. 직원이 회사 계좌로 이체하면 총무가 [입금 확인](고정 버튼)을 눌러요.
-- 보관(ADR-21 예외, ADR-29 사용자 승인): 주문 상세·청구서는 갚을 때까지 두고 [입금 확인] 7일 뒤 그 사람 그 달 것을 같이 지워요. 미납이면 남아요.
--   취소한 주문·청구에서 뺀 주문은 7일 뒤 지워요. 한도 요청은 처리(또는 만든) 뒤 7일, 그 달 늘린 한도는 그 달이 끝나면 지워요.

-- 메뉴와 직원가. 옵션은 고르는 이름만이고 값을 바꾸지 않아요. 메뉴·직원가 관리는 총무 화면(S9)이 맡아요.
create table cafe_menu (
  id text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (char_length(name) between 1 and 40),
  price_won integer not null check (price_won >= 0),
  options text[] not null default '{}',
  sold_out boolean not null default false,
  sort integer not null default 0,
  active boolean not null default true
);

-- 영업 상태 한 줄(ADR-29 "영업 중에만 주문"): 바리스타가 [영업 시작]을 누르고(open) 카페 판이 2분 안에 서버에 보였을 때(last_seen_at)만 주문을 받아요.
-- 누가 눌렀는지는 남기지 않아요(감사 로그에 가명 ID·동작만 있어요).
create table cafe_duty (
  id smallint primary key default 1 check (id = 1),
  open boolean not null default false,
  opened_at timestamptz,
  last_seen_at timestamptz
);
insert into cafe_duty (id, open) values (1, false);

-- 주문. 확인 시트를 거친 plan 하나에 주문 하나예요(plan_id unique, 같은 plan을 두 번 보내도 한 줄).
-- order_day는 한국 날짜이고 픽업 번호(pickup_no)는 날마다 1부터예요. pickup_slot은 10분 픽업 칸의 시작이에요.
-- items: [{menuId, name, priceWon, qty, options}] — 주문한 때의 메뉴 이름·직원가를 남겨요.
-- idp_subject(2묶음): 주문한 사람의 IdP 주체. 청구서로 옮겨 가서 총무 화면에 이름을 그때 붙이는 데만 써요(화면·LLM에 내보내지 않아요).
-- missed_*(3묶음, PRD F4-5): 직원이 자기 주문이 나왔어요·가져감인 그날 [못 받았어요](고정 버튼, 사유 글 없음)를 누르면 신고 표시가 붙고,
--   총무가 S9에서 [청구에서 빼기](removed)·[그대로 두기](kept)로 처리해요. 뺀 주문은 청구 합계·한 달 한도·매출 합계에서 빠지고,
--   입금 확인 전 청구서가 있으면 그 합계를 주문 행에서 다시 세요.
create table cafe_orders (
  id bigserial primary key,
  pseudonym_id text not null,
  plan_id uuid not null unique,
  order_day date not null,
  pickup_no integer not null check (pickup_no >= 1),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 5),
  total_won integer not null check (total_won >= 0),
  -- 잔 수(줄마다 수량 합). 10분 픽업 칸 상한(운영 값 cafeSlotCapacity)을 셀 때 써요.
  cups integer not null check (cups between 1 and 25),
  pickup_slot timestamptz not null,
  status text not null default 'waiting' check (status in ('waiting', 'making', 'ready', 'picked', 'cancelled')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  idp_subject text,
  missed_status text check (missed_status in ('reported', 'removed', 'kept')),
  missed_at timestamptz,
  missed_decided_at timestamptz,
  constraint cafe_orders_day_no unique (order_day, pickup_no),
  constraint cafe_orders_missed_at check ((missed_status is null) = (missed_at is null)),
  constraint cafe_orders_missed_decided check ((coalesce(missed_status, '') in ('removed', 'kept')) = (missed_decided_at is not null))
);
-- 내 주문·이번 달 합계
create index cafe_orders_person on cafe_orders (pseudonym_id, order_day);
-- 카페 판(오늘 아직 건네지 않은 주문)
create index cafe_orders_board on cafe_orders (order_day, status);
-- 픽업 칸 잔 수 세기(취소 빼고)
create index cafe_orders_slot on cafe_orders (pickup_slot) where status <> 'cancelled';
-- 보관 지우기: 취소하고 7일 지난 주문
create index cafe_orders_cancelled on cafe_orders (updated_at) where status = 'cancelled';
-- 총무 S9 "못 받았어요 확인"(처리를 기다리는 것과 처리한 것)
create index cafe_orders_missed on cafe_orders (missed_at) where missed_status is not null;
-- 보관 지우기: 청구에서 빼고 7일 지난 주문
create index cafe_orders_missed_removed on cafe_orders (missed_decided_at) where missed_status = 'removed';

-- 청구서: 한 사람의 한 달(주문한 달) 하나. 매달 1일 0시(한국) 뒤 처음 도는 보관 회차가 지난달 것을 만들어요((사람, 달) unique라 다시 돌아도 한 번).
-- 합계·건수는 주문 행(취소 뺌)에서 서버가 센 값이에요. 입금 코드는 입금자명에 넣을 짧은 글자예요.
-- 상태는 둘뿐이고 "기한 지남"은 due_on과 오늘(한국 날짜)로 셈해요. 합계가 0원이면 낼 게 없어서 처음부터 입금 확인(paid)이에요.
create table cafe_bills (
  id bigserial primary key,
  pseudonym_id text not null,
  idp_subject text,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  total_won integer not null check (total_won >= 0),
  order_count integer not null check (order_count >= 0),
  code text not null unique check (code ~ '^[A-Z0-9]{5}$'),
  issued_at timestamptz not null,
  -- 납부 기한(한국 날짜, 이날까지). 다음 날부터 새 주문을 막아요.
  due_on date not null,
  status text not null default 'unpaid' check (status in ('unpaid', 'paid')),
  paid_at timestamptz,
  constraint cafe_bills_person_month unique (pseudonym_id, month),
  constraint cafe_bills_paid_at check ((status = 'paid') = (paid_at is not null))
);
-- 총무 정산 화면(달마다)
create index cafe_bills_month on cafe_bills (month);
-- 보관 지우기: 입금 확인하고 7일 지난 청구서
create index cafe_bills_paid on cafe_bills (paid_at) where status = 'paid';
-- 기한 다음 날·주 1회 알림 대상
create index cafe_bills_unpaid on cafe_bills (due_on) where status = 'unpaid';

-- 청구 알림을 보낸 기록(중복 알림 막기). issued = 1일 청구(seq 0), overdue = 기한 다음 날(seq 0)과 그 뒤 주 1회(seq 1, 2, …).
-- 청구서를 지우면 같이 지워져요.
create table cafe_bill_notices (
  bill_id bigint not null references cafe_bills (id) on delete cascade,
  kind text not null check (kind in ('issued', 'overdue')),
  seq integer not null check (seq >= 0),
  sent_at timestamptz not null,
  primary key (bill_id, kind, seq)
);

-- 한도 늘려 달라는 요청: 금액만(그 달 한도로 바라는 값), 사유 글 없음. 대기 중 요청은 한 사람에 그 달 하나뿐이에요.
create table cafe_limit_requests (
  id bigserial primary key,
  pseudonym_id text not null,
  idp_subject text,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount_won integer not null check (amount_won between 10000 and 5000000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null,
  decided_at timestamptz,
  constraint cafe_limit_requests_decided check ((status = 'pending') = (decided_at is null))
);
create unique index cafe_limit_requests_one_pending on cafe_limit_requests (pseudonym_id, month) where status = 'pending';
-- 보관 지우기: 처리(또는 만든) 뒤 7일
create index cafe_limit_requests_kept on cafe_limit_requests ((coalesce(decided_at, created_at)));

-- 그 달에 늘린 한도([늘려 주기]). 늘린 한도는 그 달에만 써요. 달이 끝나면 지워요.
create table cafe_month_limits (
  pseudonym_id text not null,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  limit_won integer not null check (limit_won between 10000 and 5000000),
  primary key (pseudonym_id, month)
);
