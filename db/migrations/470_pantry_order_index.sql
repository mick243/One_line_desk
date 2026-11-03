-- 같이 채워요 보관 지우기(repo.ts purgeRecords, 한 시간마다)와 요청 카드 삭제가 쓰는 인덱스(11/03).
-- 마이그레이션은 한 트랜잭션 안에서 돌아서 concurrently를 쓰지 않아요. 표가 7일치뿐이라 잠깐 잠겨도 괜찮아요.

-- 주문안 줄 → 대표 카드. 지우기의 "남은 주문안에 줄이 있는 카드는 남김"(not exists ... l.bundle_id = c.id)과
-- 초안 찾기(join pantry_cards c on c.id = l.bundle_id), pantry_cards 행을 지울 때의 FK 검사가 카드마다 줄 표 전체를 훑지 않게 해요.
create index pantry_order_lines_bundle on pantry_order_lines (bundle_id);

-- 합치기 기록 → 카드. 410의 두 인덱스는 되돌리지 않은 기록(reverted_at is null)만 담아서,
-- 지우기의 "되돌린 기록까지 모두 지움"(merged_card_id = any(...) or representative_card_id = any(...))과
-- pantry_cards 행을 지울 때의 FK 검사(되돌린 기록도 카드를 가리켜요)에는 못 써요. 되돌린 기록까지 담는 인덱스를 더해요.
create index pantry_merges_merged on pantry_merges (merged_card_id);
create index pantry_merges_rep on pantry_merges (representative_card_id);
