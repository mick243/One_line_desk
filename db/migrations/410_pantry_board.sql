-- 같이 채워요(ADR-04·07·08, R3·R14·R15·R16). 10/30: 옛 001의 같이 채워요 표와 400·401을 한 파일로 합쳤어요.
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

create table pantry_similar_flags (
  card_a bigint not null references pantry_cards (id),
  card_b bigint not null references pantry_cards (id),
  source text not null check (source in ('ai', 'rule')),
  state text not null default 'showing' check (state in ('showing', 'merged', 'kept-apart')),
  primary key (card_a, card_b),
  check (card_a < card_b)
);
create index pantry_similar_flags_b on pantry_similar_flags (card_b);
