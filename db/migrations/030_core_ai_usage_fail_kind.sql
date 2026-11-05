-- AI 비용 표에 실패 종류(11/5). 정답률 표에서 회의실 채팅 해석이 "빔프로젝터" 문장마다 실패했는데 이유가 남지 않아 찾기 어려웠어요.
-- 종류 코드만 남겨요: refusal · max_tokens · no-output · parse · http-<상태 번호> · timeout · error.
-- 글·오류 본문은 넣지 않아요(본문에 입력이나 모델 출력이 섞일 수 있어서). 보관은 표와 같아요(7일, ADR-21).
alter table ai_usage add column fail_kind text check (fail_kind is null or fail_kind ~ '^[a-z0-9_-]{1,40}$');
