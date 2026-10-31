-- 분장표 행 출처(10/31 넓힐 후보 회의). 가상 분장표(seed)는 demo, 분장표 주인이 S5로 반영한 행은 upload예요.
-- upload 행이 하나라도 있으면 "시연 데이터" 띠와 MCP 모의 자료 판정(allMockData)이 거짓이 돼요.
-- 기본값을 upload로 둬서 출처를 모르면 실제 자료로 봐요(잠금이 닫히는 쪽). 이미 있는 시연 DB는 seed가 가상 분장표와 같은 행만 demo로 되돌려요.
alter table navi_rows add column source text not null default 'upload' check (source in ('demo', 'upload'));
