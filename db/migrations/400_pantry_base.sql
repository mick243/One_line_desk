-- 같이 채워요 공통 표(ADR-07·08). 판 에이전트와 주문안 에이전트가 같이 써요.

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

alter table pantry_cards add constraint pantry_cards_catalog_fk foreign key (catalog_item_id) references pantry_catalog (id);
create index pantry_cards_floor_state on pantry_cards (floor, state);
create index pantry_votes_card on pantry_votes (card_id);
