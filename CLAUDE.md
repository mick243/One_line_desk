# 한 줄 데스크 작업 안내

기획 근거는 `docs/`에 있어요. 결정 번호(D·R·M, ADR-NN)는 `docs/ADR.md`와 `docs/회의종합.pdf`를 따라요. 기능을 만들기 전에 해당 ADR과 PRD 완료 기준을 먼저 읽어요.

## 꼭 지키는 선

- LLM과 MCP에는 쓰기 도구를 주지 않아요. 쓰기는 사람이 한 번 확인한 plan 또는 고정 버튼으로만 실행해요(ADR-03, R2).
- 묻기 원문은 저장하지 않아요. DB·로그·오류 응답·URL·브라우저 저장소에 넣지 않고, POST 본문과 요청 메모리에서만 다뤄요(ADR-10, R13). 예외는 담당 팀 문의뿐이에요: 사람이 확인 시트에서 [보내기]를 누른 문의·사유만 `navi_inquiries`에 90일 보관해요(ADR-16). 알림 글에는 내용을 넣지 않아요.
- 감사 로그에는 정해진 칸만 넣어요. 검색어·슬롯 값·행 ID 같은 내용은 남기지 않아요(`core/audit.ts`가 거절해요).
- `/ask`·`/pantry/draft` 경로는 판 표에 쓰지 못해요(ADR-04). 공개 판에는 사용자가 확인한 품목 이름만 올라가요.
- 입력 검사 규칙은 `packages/shared/src/input-check/rules.ts` 하나를 브라우저와 서버가 같이 써요. 바꾸면 `RULES_VERSION`을 올려요.
- 사람 이름(남의 예약자, 분장표 담당자), 투표자는 화면·API·LLM 입력에 내보내지 않아요.
- LLM은 `core/ai/gateway.ts`(`ctx.gateway.structured()`) 하나로만 불러요. 등급 2 이상은 거부하고, 무보관 계약 확인 전에는 등급 0만 보내요. 사람이 쓴 글(묻기·판 요청 글·품목 이름)이 들어가면 자료가 가상이어도 등급 1이에요. 카드의 "AI 정리"는 모델이 실제로 판단했을 때만 붙여요(`ctx.gateway.modelBacked`).
- 새 모듈은 자기 표와 쓰기 경로만 가져요. 다른 모듈 표를 읽지 않아요. 도구는 `core/tool-registry.ts`에 먼저 적어요.

## 글

- 화면 문구와 사람용 문서는 해요체예요. 화면 문구는 `docs/화면설계.md`의 "보안이 보이는 문구" 표를 그대로 써요.
- 카드 머리 라벨은 제안·확정·안내·막힘 넷이에요. 종류는 한글 담당·공지·회의실·탕비실·모름, 코드 `navi · notices · rooms · pantry · unknown`이에요.

## 명령

- `npm run dev`: 서버(3190) + 웹(5190)
- `npm test`, `npm run typecheck`
- `npm run check`: 서식 검사 + 타입 검사 + 시험
- DB: `DATABASE_URL`이 없으면 내장 PGlite(`.data/pglite`)를 쓰고 서버가 뜰 때 마이그레이션을 적용해요. 실제 PostgreSQL은 `npm run db:up`(Docker, 5433) → `DATABASE_URL` 설정 → `npm run db:migrate`
