# 한 줄 데스크 작업 안내

기획 근거는 `docs/`에 있어요. 결정 번호(D·R·M, ADR-NN)는 `docs/ADR.md`와 `docs/회의종합.pdf`를 따라요. 기능을 만들기 전에 해당 ADR과 PRD 완료 기준을 먼저 읽어요.

## 꼭 지키는 선

- LLM과 MCP에는 쓰기 도구를 주지 않아요. 쓰기는 사람이 한 번 확인한 plan 또는 고정 버튼으로만 실행해요(ADR-03, R2). 예외는 자동 실행 허용 목록뿐이에요: 사람이 채팅으로 직접 시킨 회의실 예약·장비 대여·탕비실 물품 신청은 서버가 바로 실행해요(`autoAllowed`, `PlanService.auto`, ADR-19). 인사·보안·초대·총무 결정·운영 설정은 늘 사람이 확인해요.
- 묻기 원문은 저장하지 않아요. DB·로그·오류 응답·URL·브라우저 저장소에 넣지 않고, POST 본문과 요청 메모리에서만 다뤄요(ADR-10, R13). 예외는 담당 팀 문의뿐이에요: 사람이 확인 시트에서 [보내기]를 누른 문의·사유만 `navi_inquiries`에 7일 보관해요(ADR-16, 10/28 ADR-21로 90일 → 7일). 알림 글에는 내용을 넣지 않아요.
- 감사 로그에는 정해진 칸만 넣어요. 검색어·슬롯 값·행 ID 같은 내용은 남기지 않아요(`core/audit.ts`가 거절해요). 법정 접속기록은 감사 로그와 따로 `access_log`에 남겨요: 접속지(IP)와 처리한 정보주체 표시(문의 번호·가명 ID)만 더하고, 글·검색어·이름은 넣지 않아요. 고칠 수 없고 1년 뒤 지워요(`core/access-record.ts`, ADR-20).
- 기록은 접속기록 말고는 7일까지만 둬요(`RECORD_KEEP_DAYS`, ADR-21). 서버가 한 시간마다 지워요(`app.ts` `runRetention`, 모듈 `retention`). 기록이 쌓이는 표를 새로 만들면 지우기도 같이 넣어요.
- 세션은 쉬는 시간(운영 값 `idleTimeoutMinutes`, 기본 3시간, 5~180분)이 지나면 끊겨요. 사람이 누르지 않는 반복 요청(폴링)은 `config: { background: true }`나 웹의 `background` 옵션으로 표시해서 쉬는 시간을 늘리지 않게 해요(ADR-20).
- `/ask`·`/pantry/draft` 경로는 판 표에 쓰지 못해요(ADR-04). 공개 판에는 사용자가 확인한 품목 이름만 올라가요.
- 입력 검사 규칙은 `packages/shared/src/input-check/rules.ts` 하나를 브라우저와 서버가 같이 써요. 바꾸면 `RULES_VERSION`을 올려요.
- 사람 이름(남의 예약자, 분장표 담당자), 투표자는 화면·API·LLM 입력에 내보내지 않아요. 예외는 회의 초대뿐이에요: 예약한 사람이 고른 참석자에게만 부른 사람 이름·방·시간이 보여요(ADR-17). 참석자는 사람이 직원 검색에서 고르고, AI가 추측하지 않아요.
- 바깥 서비스(그룹웨어 캘린더·Slack)로 보내는 글에는 부른 사람 이름·시간·방·앱 주소만 넣어요. 메일·IdP 주체는 화면·LLM에 내보내지 않아요. 실제 Slack(`SLACK_BOT_TOKEN`)은 보관 조건·보안 승인 뒤에만 켜요(ADR-16·17).
- 연차 같은 개인 인사 자료(등급 2)는 본인 화면에만 보여요. 숫자는 서버가 규칙으로 계산하고, AI에는 질문 글만 보내요. DB·로그에 남기지 않아요(ADR-18).
- LLM은 `core/ai/gateway.ts`(`ctx.gateway.structured()`) 하나로만 불러요. 등급 2 이상은 거부하고, 무보관 계약 확인 전에는 등급 0만 보내요. 사람이 쓴 글(묻기·판 요청 글·품목 이름)이 들어가면 자료가 가상이어도 등급 1이에요. 카드의 "AI 정리"는 모델이 실제로 판단했을 때만 붙여요(`ctx.gateway.modelBacked`).
- 새 모듈은 자기 표와 쓰기 경로만 가져요. 다른 모듈 표를 읽지 않아요. 도구는 `core/tool-registry.ts`에 먼저 적어요.

## 글

- 화면 문구와 사람용 문서는 해요체예요. 화면 문구는 `docs/화면설계.md`의 "보안이 보이는 문구" 표를 그대로 써요.
- 카드 머리 라벨은 제안·확정·안내·막힘 넷이에요. 종류는 한글 담당·공지·회의실·탕비실·모름, 코드 `navi · notices · rooms · pantry · unknown`이에요.

## 명령

- `npm run dev`: 서버(3190) + 웹(5190), 앱 안 모의 직원으로 로그인
- `npm run idp:up` → `npm run dev:idp`: 임시 IdP(Keycloak, http://localhost:8180)로 로그인·직원 명단(가상 직원 15명, 비밀번호 `desk-demo`, `idp/realm-one-line-desk.json`)
- `npm test`, `npm run typecheck`
- `npm run db:test:up` → `npm run test:pg`: 같은 서버 시험을 실제 PostgreSQL(시험 전용 DB, Docker 5434)에서 돌려요. 기본 `npm test`는 PGlite예요
- `npm run check`: 서식 검사 + 타입 검사 + 시험
- DB: `DATABASE_URL`이 없으면 내장 PGlite(`.data/pglite`)를 쓰고 서버가 뜰 때 마이그레이션을 적용해요. 실제 PostgreSQL은 `npm run db:up`(Docker, 5433) → `DATABASE_URL` 설정 → `npm run db:migrate`
- 운영 이미지: `docker build --build-arg DESK_BUILD=<커밋> -t one-line-desk .`(Dockerfile). 판(`DESK_BUILD`)은 응답 머리 `x-desk-build`로 나가고 웹 판과 다르면 새 버전 띠가 떠요. 상태 확인은 `/health/live`(DB 안 봄)·`/health/ready`예요. 운영은 같은 서버가 웹 화면 파일(`apps/web/dist`)도 줘요(`core/web-files.ts`, 보안 머리는 `packages/shared/src/web-headers.ts` 하나). 운영은 `.env`를 읽지 않아요. 띄운 뒤 `node scripts/smoke.mjs <주소>`
- 회사별 분리(ADR-23): 회사마다 앱 한 벌을 따로 띄워요. `npm run tenant -- new|check|deploy --dir <저장소 밖 비공개 폴더>`(`apps/server/scripts/tenant.ts`). 회사는 무작위 ID(`t-xxxxxx`)로만 부르고, 회사 이름·목록·설정은 이 저장소에 넣지 않아요. 회사 고르기·회사 목록 화면을 만들지 않아요
- 운영(`NODE_ENV=production`)은 설정 검사(`apps/server/src/config.ts`)를 지나야 뜨고, 시작할 때 마이그레이션을 적용하지 않아요(`npm run db:migrate` 먼저). 시연 배포는 `DESK_MOCK_LOGIN=true`예요. 운영 설정(스위치·값·링크)은 `ops_settings` 표에 남아요
