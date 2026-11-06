-- 같이 채워요(ADR-04·07·08, R3·R14·R15·R16). 10/30: 옛 001의 같이 채워요 표와 400·401(판), 450(주문안)을 410·460 두 파일로 합쳤어요.
-- 11/6: 410_pantry_board·460_pantry_order·470_pantry_order_index를 이 파일 하나로 합쳤어요(최종 구조는 같아요).
-- 판에 남는 건 품목 이름·층·가명 작성자 ID·시각뿐이에요. 입력 원문 칸은 없어요.
-- 표는 원 요청 카드에 붙고, 합치기는 투표 행을 바꾸지 않아요. 카탈로그·층 설정·주기는 판 에이전트와 주문안 에이전트가 같이 써요.

-- 구매 카탈로그(파일 가져오기, ADR-05). 단가와 묶음 단위로 주문안을 짜요.
create table pantry_catalog (
  id text primary key,
  name text not null,
  unit_price integer not null check (unit_price > 0),
  pack_unit integer not null default 1 check (pack_unit > 0),
  aliases text[] not null default '{}'
);

-- 층별 설정(총무가 S4 설정에서 바꿔요). 최소 몫은 처음엔 같은 금액이에요(D8).
create table pantry_floor_settings (
  floor text primary key,
  min_share_won integer not null default 0 check (min_share_won >= 0),
  per_person_limit integer not null default 5 check (per_person_limit > 0),
  cycle_note text not null default ''
);

create table pantry_cycles (
  floor text not null,
  cycle_no integer not null,
  state text not null default 'open' check (state in ('open', 'closed')),
  per_person_limit integer not null check (per_person_limit > 0),
  primary key (floor, cycle_no)
);

-- 요청 카드.
-- - posted_cycle_no: 게시한 주기. 열린 카드가 지금 열린 주기보다 앞이면 "다음 주기로 넘어감"이에요(R16).
-- - post_key: 공개 미리보기 [올리기] 한 번 = 카드 하나. 같은 제안이 동시에 두 번 와도 카드는 하나예요(ADR-03 멱등).
-- - ordered_batch_at: 주문안 확정 때 함께 '주문됨'이 된 카드를 한 묶음으로 알아보려고 남겨요(S3 지난 주기 결과, S6 "주문에 들어감").
--   주문안 쪽은 state만 바꾸면 되고, 같은 트랜잭션의 now()가 들어가요.
create table pantry_cards (
  id bigserial primary key,
  floor text not null,
  item_name text not null check (char_length(item_name) between 1 and 60),
  catalog_item_id text,
  author_pseudonym_id text not null,
  state text not null default 'open' check (state in ('open', 'ordered')),
  bundle_version integer not null default 0,
  created_at timestamptz not null default now(),
  posted_cycle_no integer,
  post_key uuid,
  ordered_batch_at timestamptz,
  constraint pantry_cards_catalog_fk foreign key (catalog_item_id) references pantry_catalog (id)
);
create index pantry_cards_floor_state on pantry_cards (floor, state);
create unique index pantry_cards_post_key on pantry_cards (post_key);

create function pantry_cards_mark_ordered() returns trigger language plpgsql as $$
begin
  if new.state = 'ordered' and old.state <> 'ordered' then
    new.ordered_batch_at := now();
  end if;
  return new;
end
$$;

create trigger pantry_cards_ordered before update of state on pantry_cards
  for each row execute function pantry_cards_mark_ordered();

create table pantry_votes (
  pseudonym_id text not null,
  card_id bigint not null references pantry_cards (id),
  created_at timestamptz not null default now(),
  primary key (pseudonym_id, card_id)
);
create index pantry_votes_card on pantry_votes (card_id);

create table pantry_merges (
  id bigserial primary key,
  merged_card_id bigint not null references pantry_cards (id),
  representative_card_id bigint not null references pantry_cards (id),
  facilities_pseudonym_id text not null,
  merged_at timestamptz not null default now(),
  reverted_at timestamptz,
  check (merged_card_id <> representative_card_id)
);
-- 카드 하나는 되돌리지 않은 합치기에서 한 번만 "묶인 쪽"이 돼요. 그래서 합치기 연결은 늘 나무 모양이에요(I5).
create unique index pantry_merges_active_merged on pantry_merges (merged_card_id) where reverted_at is null;
create index pantry_merges_active_rep on pantry_merges (representative_card_id) where reverted_at is null;
-- 되돌린 기록까지 담는 인덱스(11/3). 위 둘은 되돌리지 않은 기록만 담아서, 보관 지우기(repo.ts purgeRecords)의
-- "되돌린 기록까지 모두 지움"(merged_card_id = any(...) or representative_card_id = any(...))과 카드를 지울 때의 FK 검사에는 못 써요.
create index pantry_merges_merged on pantry_merges (merged_card_id);
create index pantry_merges_rep on pantry_merges (representative_card_id);

create table pantry_similar_flags (
  card_a bigint not null references pantry_cards (id),
  card_b bigint not null references pantry_cards (id),
  source text not null check (source in ('ai', 'rule')),
  state text not null default 'showing' check (state in ('showing', 'merged', 'kept-apart')),
  primary key (card_a, card_b),
  check (card_a < card_b)
);
create index pantry_similar_flags_b on pantry_similar_flags (card_b);

-- 주문안(ADR-08, R1·R16). 주문안 에이전트가 써요.
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
-- 주문안 줄 → 대표 카드(11/3). 보관 지우기의 "남은 주문안에 줄이 있는 카드는 남김"(not exists ... l.bundle_id = c.id)과
-- 초안 찾기(join pantry_cards c on c.id = l.bundle_id), 카드를 지울 때의 FK 검사가 카드마다 줄 표 전체를 훑지 않게 해요.
create index pantry_order_lines_bundle on pantry_order_lines (bundle_id);
