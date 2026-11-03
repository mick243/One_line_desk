-- 공통 표 인덱스(11/3). 010_core.sql은 이미 적용돼서 고치지 않고 새 파일로 더해요.

-- 회의실 채팅의 자동 실행 영수증 찾기(core/plans.ts autoReceipts·autoCountToday).
-- 멱등 키 앞부분(starts_with)으로는 기본 키 인덱스를 못 써서, 가명 ID로 좁히고 시각 순서로 읽어요.
create index action_receipts_person on action_receipts (pseudonym_id, created_at);

-- 보관 기간(7일, RECORD_KEEP_DAYS)이 지난 줄 지우기. 지우기 쿼리가 거르는 칸만 걸어요.
-- plans.purge: created_at < $1(그리고 state·expires_at)
create index plans_created on plans (created_at);
-- plans.purge: action_receipts created_at < $1
create index action_receipts_created on action_receipts (created_at);
-- gateway.purgeUsage: ai_usage at < $1
create index ai_usage_at on ai_usage (at);
-- notify.purge: notifications created_at < $1. 있는 인덱스(받는 사람·부서, created_at)는 앞 칸이 달라서 지우기에 못 써요.
create index notifications_created on notifications (created_at);
