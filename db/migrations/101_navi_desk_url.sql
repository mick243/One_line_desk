-- 담당 안내(ADR-09). 창구 링크 칸을 더해요: [창구 열기]·IT 헬프데스크 링크가 여기서 와요.
-- 사람 이름 칸은 여전히 없어요(가져오기에서 버려요, D9).
alter table navi_rows add column desk_url text;
alter table navi_rows add constraint navi_rows_desk_url_scheme check (desk_url is null or desk_url ~ '^(https?://|mailto:)');

-- S5 기록 묶음은 예측 행으로 모아요.
create index navi_feedback_predicted_row on navi_feedback (predicted_row);
