-- 사내 카페 2묶음(11/6 사용자 결정, PRD F4·ADR-29, 출시 기본 끔): 청구·입금 확인·한 달 한도·미납 막기·알림·보관·총무 정산.
-- 원칙: 금액·입금 코드 말고 자유 글 칸은 없어요. 이름은 저장하지 않고, 총무 정산 화면이 열릴 때 IdP 주체로 디렉터리에서 그때 붙여요.
-- 앱은 돈을 받거나 보내지 않아요. 직원이 회사 계좌로 이체하면 총무가 [입금 확인](고정 버튼)을 눌러요.
-- 보관(ADR-21 예외, 사용자 승인): 주문 상세·청구서는 갚을 때까지 두고 [입금 확인] 7일 뒤 그 사람 그 달 것을 같이 지워요. 미납이면 남아요.
-- 한도 요청은 처리(또는 만든) 뒤 7일, 그 달 늘린 한도는 그 달이 끝나면 지워요.

-- 주문한 사람의 IdP 주체. 청구서로 옮겨 가서 총무 화면에 이름을 그때 붙이는 데만 써요(화면·LLM에 내보내지 않아요).
-- 1묶음 주문(이 칸이 생기기 전)은 비어 있어요.
alter table cafe_orders add column idp_subject text;

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
