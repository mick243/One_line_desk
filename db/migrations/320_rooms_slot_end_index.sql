-- 11/23 운영 검토: 한 시간마다 도는 7일 지우기(rooms repo purge)가 `upper(slot) < $1`로 찾는데 맞는 인덱스가 없어서 표 전체를 훑었어요.
-- 끝 시각 식 인덱스를 더해요. 넓히기만 하는 변경이라 앞 판도 그대로 떠요(장애런북 3절).
create index if not exists room_reservations_slot_end on room_reservations (upper(slot));
create index if not exists room_equipment_loans_slot_end on room_equipment_loans (upper(slot));
