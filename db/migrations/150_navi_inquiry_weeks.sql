-- 부서 간 문의 처리 셈(10/31 넓힐 후보 ④, 사용자 결정: 받은 부서 주간 건수 · 7일 보관).
-- 문의가 보관 기간(7일)이 지나 지워지는 순간에, 지우는 문의를 보낸 주(ISO 주, 한국 시간) × 받은 부서로 세어 더해요.
-- 사람(보낸 사람·받은 사람)·글·행 ID·보낸 부서 칸은 없어요. 화면은 10건 이상인 칸만 보여 줘요.
-- 셈 행도 기록이라 마지막으로 더한 뒤 7일이 지나면 지워요(ADR-21).
create table navi_inquiry_weeks (
  week text not null check (week ~ '^[0-9]{4}-W[0-9]{2}$'),
  department text not null,
  sent int not null check (sent >= 0),
  handled int not null check (handled >= 0),
  expired_open int not null check (expired_open >= 0),
  updated_at timestamptz not null,
  primary key (week, department),
  check (handled + expired_open = sent)
);
create index navi_inquiry_weeks_updated on navi_inquiry_weeks (updated_at);
