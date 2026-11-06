-- 사내 카페 주문(11/6 사용자 결정, PRD F4·ADR-29, 출시 기본 끔). 1묶음: 주문 → 카페 판 → 건네기.
-- 원칙: 주문 문장·자유 글 칸은 없어요(옵션은 메뉴가 정한 이름만). 사람은 가명 ID(p_…)로만 남고 이름은 넣지 않아요.
-- 금액은 서버가 메뉴 직원가 × 수량으로 계산해서 주문 행에 남겨요(AI는 금액을 만들지도 보지도 않아요).
-- 청구·입금 확인·한도·미납 표는 다음 묶음이에요.

-- 메뉴와 직원가. 옵션은 고르는 이름만이고 값을 바꾸지 않아요. 메뉴·직원가 관리는 총무 화면(S9, 다음 묶음)이 맡아요.
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
-- items: [{menuId, name, priceWon, qty, options}] — 주문한 때의 메뉴 이름·직원가를 남겨요(청구는 다음 묶음).
-- 보관(ADR-21 예외, ADR-29 사용자 승인): 취소한 주문은 취소하고 7일 뒤 지워요. 다른 주문은 청구·[입금 확인] 7일 뒤 지우기(다음 묶음)까지 남아요.
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
  constraint cafe_orders_day_no unique (order_day, pickup_no)
);
-- 내 주문·이번 달 합계
create index cafe_orders_person on cafe_orders (pseudonym_id, order_day);
-- 카페 판(오늘 아직 건네지 않은 주문)
create index cafe_orders_board on cafe_orders (order_day, status);
-- 픽업 칸 잔 수 세기(취소 빼고)
create index cafe_orders_slot on cafe_orders (pickup_slot) where status <> 'cancelled';
-- 보관 지우기: 취소하고 7일 지난 주문
create index cafe_orders_cancelled on cafe_orders (updated_at) where status = 'cancelled';
