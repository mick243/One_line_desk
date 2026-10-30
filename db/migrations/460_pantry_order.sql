-- 주문안(ADR-08, R1·R16). 주문안 에이전트가 써요. 10/30: 옛 450과 같은 내용을 새 이름으로 옮겼어요.
-- 줄에는 묶음 표 수만 있고 투표자는 없어요. 설명은 숫자 검사를 지난 AI 문장이나 틀 문장이에요.

create table pantry_order_plans (
  id uuid primary key,
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'replaced')),
  budget integer not null check (budget >= 0),
  -- 만들 때의 층별 기준 [{ floor, minShare, requested }]. 총무가 줄을 고친 뒤 검사기도 이걸로 돌려요.
  floor_basis jsonb not null,
  explained boolean not null default false,
  created_at timestamptz not null,
  confirmed_at timestamptz
);

-- 고치는 중인 주문안은 하나뿐이에요. 새로 만들면 앞의 것은 replaced가 돼요.
create unique index pantry_order_plans_one_draft on pantry_order_plans (status) where status = 'draft';

create table pantry_order_lines (
  plan_id uuid not null references pantry_order_plans (id),
  line_no integer not null check (line_no > 0),
  -- 대표 카드 ID와 그때의 묶음 버전. 확정 순간 판의 묶음이 바뀌었는지 봐요.
  bundle_id bigint not null references pantry_cards (id),
  bundle_version integer not null,
  floor text not null,
  item_name text not null,
  catalog_item_id text,
  votes integer not null check (votes >= 0),
  unit_price integer,
  pack_unit integer,
  quantity integer not null check (quantity >= 0),
  amount integer not null check (amount >= 0),
  included boolean not null,
  reason text not null check (reason in ('층 최소 몫', '표 대비 값', '예산 초과로 뺌', '카탈로그에 없음')),
  rank integer not null check (rank > 0),
  explanation text not null check (char_length(explanation) between 1 and 200),
  explanation_source text not null check (explanation_source in ('ai', 'template')),
  edited boolean not null default false,
  primary key (plan_id, line_no)
);
