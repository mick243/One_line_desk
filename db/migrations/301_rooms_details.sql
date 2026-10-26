-- 회의실 둘러보기(10/26): 방 사진 주소와 설비 설명. 장부가 주는 값이에요(시연은 그림 주소와 가상 설비).
-- equipment(정해진 목록)는 찾기 조건이고, facilities는 화면에 보여 주는 설명이에요.
alter table rooms add column photo_url text;
alter table rooms add column facilities text[] not null default '{}';
