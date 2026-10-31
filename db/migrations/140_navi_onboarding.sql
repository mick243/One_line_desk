-- 신규 입사자 첫 2주 할 일(10/31 넓힐 후보 ①). 분장표 행에 "온보딩 주차"(1·2, 비어 있으면 아님) 칸을 더해요.
-- 분장표 주인이 S5 파일로 관리하고 기준 자료라 7일 지우기 대상이 아니에요. 누가 무엇을 했는지(진행)는 저장하지 않아요(ADR-21).
alter table navi_rows add column onboarding_week smallint check (onboarding_week is null or onboarding_week in (1, 2));
