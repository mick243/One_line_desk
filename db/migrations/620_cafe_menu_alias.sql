-- 사내 카페 메뉴 줄임말(11/17, ADR-29 보강). 총무가 S9 메뉴 관리에서 메뉴마다 직접 적어요(AI 제안 없음).
-- 낱말 규칙 주문 해석과 홈이 카페 주문 문장을 알아보는 낱말에 같이 써요. 모델에는 보내지 않아요(모델에는 메뉴 이름·옵션 이름만).
-- 넓히기만 해요: 610_cafe.sql의 cafe_menu에 칸 하나를 더해요. 있던 메뉴는 빈 목록이에요.
-- 글자·길이·겹침·다른 기능 낱말 검사는 서버(modules/cafe/alias.ts)가 하고, 여기서는 개수 상한만 한 번 더 봐요.
-- 메뉴 표는 기록이 쌓이는 표가 아니라 보관 지우기(ADR-21) 대상이 아니에요.
alter table cafe_menu add column aliases text[] not null default '{}' check (cardinality(aliases) <= 5);
