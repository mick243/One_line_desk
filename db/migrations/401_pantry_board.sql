-- 같이 채워요 판(ADR-04·07, R3·R14·R15·R16). 판 에이전트 몫이에요.
-- 판에 남는 건 품목 이름·층·가명 작성자 ID·시각뿐이에요. 입력 원문 칸은 없어요.

-- 게시한 주기. 열린 카드가 지금 열린 주기보다 앞이면 "다음 주기로 넘어감"이에요(R16).
alter table pantry_cards add column posted_cycle_no integer;

-- 공개 미리보기 [올리기] 한 번 = 카드 하나. 같은 제안이 동시에 두 번 와도 카드는 하나예요(ADR-03 멱등).
alter table pantry_cards add column post_key uuid;
create unique index pantry_cards_post_key on pantry_cards (post_key);

-- 주문안 확정 때 함께 '주문됨'이 된 카드를 한 묶음으로 알아보려고 남겨요(S3 지난 주기 결과, S6 "주문에 들어감").
-- 주문안 쪽은 state만 바꾸면 되고, 같은 트랜잭션의 now()가 들어가요.
alter table pantry_cards add column ordered_batch_at timestamptz;

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

-- 카드 하나는 되돌리지 않은 합치기에서 한 번만 "묶인 쪽"이 돼요. 그래서 합치기 연결은 늘 나무 모양이에요(I5).
create unique index pantry_merges_active_merged on pantry_merges (merged_card_id) where reverted_at is null;
create index pantry_merges_active_rep on pantry_merges (representative_card_id) where reverted_at is null;
create index pantry_similar_flags_b on pantry_similar_flags (card_b);
