# 보안·QA 검토 — 다섯 모듈 합친 뒤

- 날짜: 2026-10-26 · 검토: desk-reviewer(코드는 고치지 않았어요)
- 범위: `apps/server/src/**`(core·routes·modules), `apps/web/src/**`, `packages/shared/src/**`, `db/migrations/*.sql`
- 기준: `CLAUDE.md` 꼭 지키는 선, `docs/ADR.md`("시험으로 지키는 것" 표, ADR-01~15), `docs/PRD.md` 완료 기준, `docs/화면설계.md` "보안이 보이는 문구"

## 처리 결과(리드, 2026-10-26)

| 항목 | 상태 | 어떻게 |
|---|---|---|
| H1 | 고침 | 탕비실 LLM 호출 넷을 등급 1로 바꿨어요. 계약 전에는 규칙·틀 문장으로 가요. 바로 실행에서 고친 값은 core가 공통 검사로 다시 보고(`plans.direct`), 만료 경로의 `reSearch`는 `checkItemName`을 먼저 돌려요. 시험은 `pantry/security.test.ts`, `plans.test.ts` "[ADR-11 시험]"에 있어요 |
| H2 | 고침 | 토큰·plan에서 `draftName`을 빼고 HMAC으로 바꿨어요. 막힌 결과는 `PlanHandler.storedParams`로 이름을 빼고, 막힘 카드에도 이름이 없어요. 시험: "[H2·F3 카나리]" |
| M1 | 일부(10/29) | 서버 시험 전체가 실제 PostgreSQL에서도 돌아요(`npm run test:pg`, CI `postgres` 잡). 두 연결로 겹치는 경쟁 시험은 다음 일이에요 |
| M2·M3 | 고침(PGlite로만 확인) | +1·거두기·게시는 대표 카드를 `FOR SHARE`로 잠그고, 확정은 대표와 묶인 카드를 ID 순 `FOR UPDATE`로 잠가요. 시험은 `pantry/locks.test.ts`에 있어요 |
| M4 | 고침 | 운영 환경은 `DESK_MOCK_LOGIN=true` 없이는 모의 IdP로 뜨지 않아요. 시험: app.test "[ADR-13 시험] 운영 환경은…" |
| M5 | 일부 | 예시 칩·S4·S5 진입이 끄기 스위치를 따라요(L7). `/api/ask` 429, 로그·URL 카나리, 10명 미만 통계 숨김은 남았어요 |
| L1 | 그대로 | MCP를 끄면 `/mcp`가 막고, 갱신은 다시 켤 때 재연결이 없게 일부러 살려 둬요. 갱신 토큰 재사용 감지는 동시 갱신과 부딪힐 수 있어서 다음 일이에요 |
| L6·L7·L8·L9·L12·L13·L17 | 고침 | 4xx는 `bad-request`·warn, 예시 칩 숨김, `edits` 스키마, 분장표 CSV 수식 막기, 지난 시작 시각 예약 막기, 영수증을 만료보다 먼저 보기, 낡은 주석·문서 |
| L10 | 고침 | 주문안 만들기를 advisory 잠금으로 차례로 처리해요 |
| (추가) ADR-08 다시 볼 조건 | 고침 | 사용자 결정(D8 1단계 보정)으로 1단계에 정확한 채움 확인을 넣었어요. "채울 수 있음"인데 못 받은 층은 무작위 800개에서 0건이고, `plan-compare.test.ts`가 실패로 막아요 |
| L2·L3·L4·L5·L11·L14·L15·L16 | 남음 | 실제 어댑터 연결·배포 때 같이 봐요 |
| (추가) "AI 정리" 표시 | 고침 | `gateway.modelBacked`와 `AskInput.aiParsed`로, 모델이 실제로 판단했을 때만 붙여요 |

## 요약

| 심각도 | 개수 | 항목 |
|---|---|---|
| 높음 | 2 | H1 탕비실 LLM 호출이 사람이 쓴 글을 등급 0으로 보내 계약 전 잠금(R6)을 건너뛰어요 · H2 원문에서 뽑은 이름과 막힌 이름이 `plans`·`action_receipts`에 남아요 |
| 중간 | 5 | M1 동시성 시험이 PGlite(연결 하나)에서만 돌아요 · M2 +1·거두기와 주문안 확정 경쟁(I6) · M3 주문안 확정과 합치기 경쟁 · M4 운영 환경에서도 모의 로그인이 열려요 · M5 ADR 시험 표 빈칸 |
| 낮음 | 17 | 아래 "낮음" 절 |

- `npm test`: 통과. shared 1파일 10개, server 24파일 275개(57초). 웹 워크스페이스는 시험이 없어요.
- `npm run typecheck`: shared·server·web 모두 통과.
- H1·H2·M4는 임시 탐침(scratchpad의 tsx 스크립트, 메모리 PGlite, 기록용 LLM 공급자)으로 실제로 재현했어요. M2·M3는 PostgreSQL READ COMMITTED 잠금 규칙으로 따진 것이라 **실제 PostgreSQL에서 재현 확인 필요**예요.

---

## 높음

### H1. 탕비실 LLM 호출이 사람이 쓴 글을 등급 0으로 보내요(계약 전 잠금 우회)

- 파일: `apps/server/src/modules/pantry/similarity.ts:120-130`(extractDraft, `grade: GRADE.public` 124줄), `:155-168`(judgeName, 158줄), `:189-198`(collectPairs, 192줄), `apps/server/src/modules/pantry/order/explain.ts:106`, 부르는 곳 `modules/pantry/service.ts:157-169`(draftFromText·ask), `core/plans.ts:106-107`(만료된 바로 실행 → reSearch)
- 무엇이 문제: 게이트웨이는 계약 전에는 등급 0만 통과시켜요(CLAUDE.md, ADR-10, R6). 그런데 탕비실 모듈은 등급을 0으로 박아 두고 아래 글을 그대로 넣어요.
  1. S3 요청 쓰기 칸 글 전체(최대 1000자, 이메일·IP만 가린 것). PRD 데이터 표의 "묻기 입력 원문"과 같은 성격(등급 1, 2·3이 섞일 수 있음)이에요.
  2. `/api/ask`에서 탕비실로 간 질문에서 뽑은 이름. 라우터는 같은 질문을 등급 1로 보내 거절되는데, 탕비실 `ask()`가 규칙으로 뽑은 문장 조각(최대 40자)을 등급 0으로 다시 보내요. 주석(`service.ts:164` "묻기 원문은 등급 1이라 AI로 다시 안 보내요")과도 반대예요.
  3. 만료된 게시 토큰으로 `/api/plans/direct`를 부르면, 사용자가 고친 `itemName`이 `checkItemName` 재검사 없이 `reSearch → draftForName → judgeName`으로 LLM에 가요(ADR-11 서버 재검사도 건너뜀).
  4. 판 품목 이름·주문안 줄 이름(collectPairs·explain)도 실제 파일럿에서는 직원이 쓴 글이라 등급 1인데, 어댑터가 실제로 바뀌어도 등급이 따라 바뀌지 않아요.
- 어떤 입력으로 깨지나(탐침 결과, `DESK_AI_PROVIDER=anthropic`·계약 false와 같은 조건):
  - `POST /api/pantry/draft {"text":"김가상 과장님이 부탁한 녹차 티백 채워 주세요 DRAFTCANARY-2"}` → 공급자에 `pantry/draft-item-name` 등급 0 호출 1건, 입력에 사람 이름·카나리가 그대로 있음.
  - `POST /api/ask {"text":"법인카드 분실 ASKCANARY3","kind":"pantry"}` → `pantry/same-item` 등급 0 호출, 입력 `{"새품목":"법인카드 분실 ASKCANARY3", …}`.
  - 만료된 게시 토큰 + `edits.itemName = "AKIAABCDEFGHIJKLMNOP"`(키 형식, 공통 검사 잠금 대상) → 200 `expired`, 같은 값이 공급자로 감.
- 고칠 방향: 사람이 쓴 글이 들어가는 호출은 navi `PICK_GRADE`처럼 등급 1로 보내고, 계약 전에는 결정적 대안(이름 규칙)으로 가게 해요. 등급을 모듈이 박지 말고 "자료 출처(어댑터 mock 여부) + 사람 입력 여부"로 정하는 도우미를 core에 두면 실제 어댑터로 바꿀 때도 안전해요. `plans.direct` 만료 경로는 reSearch 전에 처리기 검사(`checkItemName`)를 돌리거나 만료 시 규칙 판정만 써요. 시험: 기록용 공급자로 계약 전 위 세 경로의 공급자 호출 0건. `similarity.ts:123` 주석의 "리드 지시"가 의도된 결정이라면 ADR-10·PRD 데이터 표·CLAUDE.md와 어긋나니 결정 기록부터 맞춰야 해요.

### H2. 원문에서 뽑은 이름(`draftName`)과 막힌 이름이 DB에 남아요

- 파일: `apps/server/src/modules/pantry/service.ts:40-52`(PostParams의 `draftName`), `:140-147`(초안 토큰), `:185-191`(막힘 시 재시도 토큰에 `draftName: name`), `apps/server/src/core/plans.ts:119-126`(params 저장), `:129-135`(영수증 저장)
- 무엇이 문제: 공개 미리보기에서 사용자가 이름을 고쳐 올리면, 고치기 전 이름(원문 문장에서 규칙·AI로 뽑은 조각)이 `plans.params.draftName`에 그대로 저장돼요. 재검사에 막힌 이름은 `plans.params.itemName`에 평문으로, `action_receipts.result` 안 재시도 토큰(base64)에도 들어가요. ADR-04 "판에 저장되는 건 품목 이름·층·가명 작성자 ID·시각뿐", ADR-10/R13 "원문 저장 0건", F1·F3 카나리 완료 기준, S6 "남기지 않는 것: 묻기에 쓴 문장"과 어긋나요. 지금 카나리 시험(`board.test.ts:52`)은 게시하기 전까지만 봐서 못 잡아요.
- 어떤 입력으로 깨지나(탐침 결과):
  - 초안 `"김가상 과장님 부탁 보리차 PLANCANARY9 채워 주세요"` → 미리보기에서 이름을 "보리차"로 고쳐 올림 → `plans.params = {"itemName":"보리차","draftName":"김가상 과장님 보리차 PLANCANARY9", …}`. `checkItemName`이 막는 사람 이름 패턴이 DB에 남아요.
  - 미리보기 이름을 `"보리차 010-9876-5432"`로 고쳐 올림 → 막힘 카드(정상)인데 `plans` 평문과 `action_receipts`(토큰을 풀면)에 전화번호가 남아요.
- 고칠 방향: 토큰과 plan 매개변수에서 `draftName`을 빼요. "이름을 안 고쳤는지"는 서명한 토큰 안의 HMAC(draftName)이나 `aiJudged: true` 같은 참·거짓만으로 판단해요. 막힘 결과는 plan 행·영수증에 이름 없이 남기거나(막힘이면 params를 비우기) 막힌 이름이 들어간 재시도 토큰을 영수증에 넣지 않아요. 시험: 고친 이름·막힌 이름으로 올린 뒤 DB 전체 덤프(토큰 base64를 풀어서도)에서 원문 카나리·전화번호 0건.

---

## 중간

### M1. 동시성 시험이 모두 PGlite(연결 하나)에서만 돌아요

- 파일: `apps/server/src/core/db/pglite.ts`(`tx`가 `pg.transaction`), `modules/pantry/invariants.test.ts:140·188·226·247`, `modules/rooms/rooms.test.ts:306·320·456`, `core/plans.test.ts:103`
- 무엇이 문제: PGlite는 연결 하나라 `Promise.allSettled`로 던진 트랜잭션이 차례로 돌아요. ADR 표의 "병렬" 시험(plan 한 번 실행, 동시 확정, 불변식 I1~I8, 두 총무 409)은 실제 PostgreSQL READ COMMITTED에서의 경쟁·잠금을 검사하지 못해요. `TEST_DATABASE_URL`을 쓰는 시험이 0개예요(CONVENTIONS 7절에는 있다고 적혀 있어요). M2·M3 같은 경쟁은 지금 시험으로는 영원히 안 보여요.
- 고칠 방향: `TEST_DATABASE_URL`이 있을 때 같은 불변식·동시 확정·영수증·주문안 경쟁 시험을 실제 PostgreSQL(`npm run db:up`)로 돌리는 묶음을 두고, 시연 전 CI에서 한 번은 돌려요.

### M2. +1·거두기와 주문안 확정이 겹치면 주문된 묶음에 표가 생겨요(I6)

- 파일: `modules/pantry/service.ts:270-292`(vote), `:317-325`(openBundleOnMyFloor가 잠금 없이 `state`를 읽음), `modules/pantry/order/service.ts:229-236`(confirm), `modules/pantry/repo.ts:80`(insertVote)
- 무엇이 문제: vote는 사람 단위 잠금(advisory)만 잡고 카드 상태를 잠금 없이 읽은 뒤 INSERT해요. 주문안 확정의 `update pantry_cards set state='ordered'`는 FOR NO KEY UPDATE라서 표 INSERT의 외래 키 검사(FOR KEY SHARE)와 부딪히지 않아요. 순서: vote가 `open`을 읽음 → 확정 커밋 → vote가 INSERT·커밋 → `주문됨` 카드에 새 표(I6 위반). 거두기도 같은 틈으로 닫힌 표를 지울 수 있어요. 시험(`board.test.ts` "[ADR-07 I6]")은 차례로만 봐요. **실제 PostgreSQL에서 재현 확인 필요**.
- 고칠 방향: vote·withdraw·게시에서 묶음 대표(와 멤버) 카드를 `select … for share`로 잠근 뒤 상태를 봐요(합치기의 FOR UPDATE와는 기다림만 생기고 409는 안 생겨요, I8 유지). 또는 `pantry_votes` INSERT 트리거로 카드 `state='open'`을 확인해요.

### M3. 주문안 확정과 합치기가 겹치면 묶인 카드가 판에서 사라져요

- 파일: `modules/pantry/order/service.ts:229-236`, `modules/pantry/service.ts:510-543`(merge)
- 무엇이 문제: 확정은 `listOpenBundles`를 잠금 없이 읽고 버전을 비교해요. 합치기가 커밋되기 전에 읽으면 옛 버전이 맞아서 통과하고, `markCardsOrdered`가 합치기 커밋을 기다렸다가 옛 카드 목록만 `ordered`로 바꿔요. 그러면 새로 묶인 카드는 `open`인데 대표가 `ordered`라 `listOpenBundles`의 뿌리에서 닿지 않아 판·상한 셈에서 빠져요(표가 사라진 것처럼 보임). R3 "두 총무가 같은 묶음 → 409 하나"가 확정과 합치기 사이에는 지켜지지 않아요. **실제 PostgreSQL에서 재현 확인 필요**.
- 고칠 방향: 확정에서 넣을 묶음의 대표 카드를 `repo.lockCards`(ID 순 FOR UPDATE)로 먼저 잠근 뒤 묶음·버전을 읽어요. 합치기·되돌리기 쪽은 이미 같은 순서로 잠가서 교착 없이 한쪽이 409가 돼요.

### M4. 운영 환경(NODE_ENV=production)에서도 모의 로그인이 열려요

- 파일: `apps/server/src/app.ts:51`(`opts.adapters ?? createMockAdapters()`), `apps/server/src/index.ts`(어댑터를 넘기지 않음), `apps/server/src/routes/auth.ts:9-40`
- 무엇이 문제: 운영 설정은 비밀 값만 강제하고, IdP는 늘 모의예요. 탐침: production 설정으로 띄운 앱에서 `GET /api/auth/mock-users` 200(가상 직원 이름·부서·층 목록, 로그인 없이), `POST /api/auth/login {"idpSubject":"mock|emp-005"}` 200 → 역할 `operator`. 누구나 운영자·총무·분장표 주인으로 들어가 스위치를 바꾸고 MCP 승인까지 받을 수 있어요. 로그인 요청에는 CSRF도 없어요(모의 전용이라 그 자체는 낮음).
- 고칠 방향: `production`이면 `loginChoices`가 있는 IdP로는 시작을 거부하거나 두 경로를 404로 막고, 시연 배포는 `DESK_MOCK_LOGIN=true` 같은 명시 스위치로만 열어요. 시연 MCP 클라이언트 비밀(`modules/mcp/index.ts:17-22`)도 저장소에 있으니 같은 스위치에 묶어요.

### M5. ADR "시험으로 지키는 것" 표의 빈칸

아래 "ADR 시험 표 대조"의 "일부·없음" 줄이에요. 매 CI로 정한 줄 중 시험이 없거나 반만 있는 것:
- 10·11 카나리: DB 덤프만 봐요(`app.test.ts:54`, `navi.test.ts:192`, `board.test.ts:52`). 앱 로그·URL·자동 완성 확인이 없고, 게시까지 간 흐름은 H2로 깨져요.
- 13 요청 횟수: `/api/ask` 429 시험이 없어요(게시·+1·피드백·MCP만 있음).
- 01·10 모듈 허용 목록: `toolsForModule()`은 시험만 하고 실제 LLM 호출 경로 어디에도 쓰지 않아요. "LLM 입력에 다른 모듈 자료 없음" 스냅샷이 없어요.
- 12 끄기 스위치: 웹(예시 칩 숨김·단독 모드 첫 화면) 시험이 없고, 예시 칩은 실제로 안 숨겨져요(L7).
- 10 감사 로그 형식: "10명 미만 묶음 통계는 안 보임" 기능·시험이 없어요. `/api/ops/settings`(`routes/config.ts:35-38`)는 감사 로그 원 행 20개(가명 ID·시각·묻기 모듈 종류)를 그대로 줘요.
- 07 불변식: 주문안 확정과 +1·합치기의 동시 시험이 없어요(M2·M3).

---

## 낮음

| # | 무엇 | 파일:줄 | 왜·어떻게 깨지나 | 고칠 방향 |
|---|---|---|---|---|
| L1 | MCP 갱신이 MCP 스위치·`runnable()`을 안 봐요. 갱신 토큰 재사용 감지도 없어요 | `modules/mcp/auth-service.ts:207-238`(교환은 187줄에서 봄) | MCP를 끈 뒤에도 갱신이 새 토큰을 줘요. `/mcp`가 막아서 자료는 안 나가지만 "스위치를 끄면 연결 거부"와 다르게 보여요. 회전된 옛 토큰이 다시 오면 실패만 하고 승인은 그대로예요 | 갱신에도 `runnable()` 확인. 옛 토큰 재사용이면 승인 폐기 검토 |
| L2 | 어댑터 mock 값이 박혀 있어요 | `modules/notices/service.ts:72·93`(`mock: true`), `notices/index.ts:15`, `navi/index.ts:20`, `pantry/index.ts:19` | 실제 공지 어댑터로 바꿔도 `mock: true`가 남으면 `mcp-route.ts:227`의 "실제 자료는 승인 클라이언트만" 잠금이 열린 채(fail-open)예요. 확인 필요(미래 위험) | mock 여부를 어댑터 capabilities 한 곳에서 읽게 해요 |
| L3 | 앱 확인 링크의 제안 토큰은 base64 평문이에요 | `core/proposal-token.ts:26-30`, `modules/mcp/mcp-route.ts:204` | `/r/<토큰>`이 외부 AI 응답·브라우저 기록·호스팅 접근 기록에 남고, 풀면 가명 ID(감사 로그·표와 같은 값)와 조건이 보여요. ADR-14가 받아들인 몫이지만 가명 ID까지 읽힐 필요는 없어요 | MCP 토큰처럼 봉인(AES-GCM)하거나 링크용 토큰에서 가명 ID를 HMAC으로 바꿔요 |
| L4 | 분장표 반영의 버전 검사에 잠금이 없어요 | `modules/navi/service.ts:295-317`(304줄) | 같은 부서 두 사람이 같은 미리보기로 다른 파일을 동시에 반영하면 실제 PostgreSQL에서 둘 다 통과해 나중 것이 덮어써요 | 부서 단위 advisory 잠금 또는 행 `for update` 뒤 버전 비교 |
| L5 | plan 만들기에 횟수 제한이 없고 토큰을 여러 번 써요. 예약 개수 상한도 없어요 | `routes/plans.ts:7-15`, `core/plans.ts:53-71` | 유효한 토큰 하나로 `/api/plans`를 반복하면 `plans` 행이 끝없이 늘어요. 한 사람이 모든 방을 잡을 수 있어요(모의 장부) | `/api/plans`에 횟수 제한, 사람당 열린 예약 수 상한(운영 설정) |
| L6 | 프레임워크 4xx가 `server-error`로 나가고 error 수준으로 남아요 | `app.ts:79-84` | JSON이 아닌 본문(400)·지원하지 않는 형식(415)·너무 큰 본문(413)에 `{"error":"server-error"}`. 로그에는 본문이 없어요(탐침으로 확인) | `statusCode < 500`이면 `bad-request` 등으로, 로그는 warn |
| L7 | S1 예시 칩이 끄기 스위치를 따르지 않아요 | `apps/web/src/screens/Ask.tsx:10·46` | 회의실을 `끔`으로 해도 "내일 3시 6명 회의실" 칩이 보여요(R4·ADR-12 "예시 칩 숨김") | 공개 설정을 받아 꺼진 종류 칩을 빼요 |
| L8 | 느슨한 본문 스키마 | `routes/plans.ts:36`(`edits`는 `maxProperties`만), 본문 스키마 없는 POST: `routes/plans.ts:18`, `routes/auth.ts`(logout·logout-all), `pantry/order/index.ts:52·82` | 코드가 `editableKeys`·zod로 다시 막아서 지금은 안전해요. 다만 "경로마다 additionalProperties: false"(CONVENTIONS 5절)와 다르고 모르는 본문을 조용히 받아요 | `edits`에 `properties: { itemName }`·`additionalProperties: false`, 본문 없는 경로는 빈 객체 스키마 |
| L9 | 분장표 내보내기 CSV에 수식 방어가 없어요 | `modules/navi/chart-csv.ts:175` | `=`·`+`·`-`·`@`로 시작하는 칸이 표 프로그램에서 수식으로 읽혀요(주문안 내보내기 `order/service.ts` `csvCell`은 막음) | 같은 `csvCell` 규칙 적용 |
| L10 | 주문안을 동시에 두 번 만들면 500이에요 | `modules/pantry/order/repo.ts:94-100` | 두 트랜잭션이 모두 옛 초안을 `replaced`로 바꾼 뒤 INSERT → 초안 하나 유일 인덱스 위반 → `server-error` | `pantry_order_plans`에 advisory 잠금 또는 충돌을 409로 |
| L11 | 인가 코드 교환 중 "모든 기기 로그아웃"이 끼면 승인이 살아남아요 | `modules/mcp/auth-service.ts:175-205`, `:294-298` | 교환이 코드를 꺼낸 뒤 재직 확인을 기다리는 사이 `revokeAll`이 끝나면, 뒤이어 `upsertGrant`가 새 승인을 만들어요(틈이 좁음) | 교환 마지막에 세션·폐기 시각을 다시 보거나 사람 단위 잠금 |
| L12 | 확인 순간 이미 시작한 구간도 예약돼요 | `modules/rooms/service.ts:241-268` | plan 만료(10분) 안에 시작 시각이 지나도 실행 때 다시 안 봐요 | 실행 때 `start >= now` 재검사, 지났으면 다시 찾기 |
| L13 | 바로 실행은 영수증보다 만료를 먼저 봐요 | `core/plans.ts:107-111` | 올린 뒤 같은 토큰이 만료돼 다시 오면 이전 결과 대신 새 미리보기를 줘요(같은 품목 카드가 대개 막지만 중복 게시 길이 생김) | 영수증을 먼저 보고 없을 때만 만료 처리 |
| L14 | 요청 횟수 카운터 구조 | `core/rate-limit.ts:5-23` | 키가 지워지지 않아 메모리가 계속 늘고, 동작별 상한 없이 값 하나(`rateLimitPerMinute`)를 같이 써요(ADR-13 "동작별 상한") | 창이 지난 키 정리, 동작별 상한 표 |
| L15 | 클릭재킹 막는 헤더가 Vite 개발·미리보기에만 있어요 | `apps/web/vite.config.ts:8` | 운영 정적 호스팅에서 동의 시트(`/oauth/consent`)가 틀에 들어갈 수 있어요(배포 설정 확인 필요) | 호스팅 설정이나 서버 응답 머리에도 같은 값 |
| L16 | 분장표 자유 칸의 사람 이름은 못 막아요 | `modules/navi/chart-csv.ts:157-170` | "담당자 이름" 칸은 버리지만 창구·지금 할 일 칸에 "김가상 대리"를 적으면 DB·카드·LLM 입력에 가요(D9의 한계) | 반영 미리보기에서 `checkItemName`의 사람 이름 패턴으로 경고 |
| L17 | 낡은 주석·문서 | `modules/mcp/auth-service.ts:104`(이제 `MCP_TOKEN_SECRET`을 씀), `modules/navi/routes.ts:26-29`(removeAdditional 설명, 이제 앱 전체가 거부해서 이 훅은 중복이고 인증보다 먼저 400을 줌), `modules/README.md`(mcp 줄 없음), `.env.example:8`("DB 없이 떠요" → 실제는 PGlite) | 다음 사람이 잘못 고칠 수 있어요 | 주석·문서 맞추기 |

---

## 리드가 바꾼 공통 바닥 확인

| 바뀐 곳 | 결과 |
|---|---|
| `core/plans.ts` direct()가 확인 시트 있는 처리기 거부 | 맞아요(101줄, `plans.test.ts` "[ADR-03 시험] 확인 시트가 있는 제안은 바로 실행으로 보낼 수 없어요"). |
| `core/plans.ts` 영수증을 트랜잭션 안 advisory 잠금 뒤 다시 확인 | 맞아요(113-117줄). READ COMMITTED에서 잠금 뒤 SELECT가 새 스냅숏이라 먼저 끝난 쪽 영수증을 봐요. 다만 만료 검사가 영수증보다 앞이고(L13), 만료 경로는 고친 값을 검사하지 않아요(H1). 막힘 결과 저장은 H2. |
| `core/fixed-action.ts` 같은 잠금 | 맞아요(45줄, INSERT에 `on conflict do nothing`). 스위치 검사(33-34줄)가 영수증보다 앞이라 꺼진 뒤 재시도는 저장된 결과 대신 409예요(사소). +1·거두기·따로 두기·설정·끊기는 멱등 키 없이 SQL 자체가 멱등이라 괜찮아요. |
| `app.ts` ajv `removeAdditional: false` | 맞아요. 탐침: `/api/ask`·`/api/pantry/votes`에 모르는 칸 → 400. 이 설정을 직접 확인하는 시험은 없어요(피드백 시험은 navi 훅으로 통과). |
| `app.ts` `ctx.dataAdapters` | 맞아요. 모듈 어댑터까지 모으고(86줄), MCP 정책이 부를 때마다 읽어요. mock 값이 박힌 어댑터는 L2. |
| `routes/config.ts` MCP 켤 때 `canEnable()` | 맞아요(70줄, 서비스가 없으면 거부, `policy.test.ts` "[ADR-12·15 시험]"). `/mcp`·교환·동의도 요청마다 `runnable()`을 다시 봐서 두 겹이에요. 갱신만 안 봐요(L1). |
| `config.ts` `MCP_TOKEN_SECRET` | 맞아요(39줄, 운영에서 필수). 주석 하나가 낡았어요(L17). |
| `core/rate-limit.ts` 동작 칸 | 동작 칸은 맞아요. `/api/ask` 429 시험 없음(M5), 구조 문제는 L14. |

## ADR "시험으로 지키는 것" 표 대조

| ADR | 무엇 | 상태 | 근거·빈칸 |
|---|---|---|---|
| 10·11 | 질문 원문 저장 0건 | 일부 | DB 덤프만(`app.test.ts:54`, `navi.test.ts:192`, `board.test.ts:52`). 로그·URL·자동 완성 시험 없음. 게시까지 가면 깨짐(H2). 브라우저 저장소는 규칙 시험(정적 검색)만 |
| 10 | 묻기 감사 로그 칸 | 있음 | `router.test.ts` "[R11]", `navi.test.ts` "[F1 완료 기준·ADR-10]" |
| 10 | 알림 주소 표 | 해당 없음 | 다음 2주 |
| 11 | 브라우저·서버 검사 일치 | 일부 | 같은 함수를 같이 써서 구조로 맞아요. 예시 문장 표는 `check.test.ts` 10개뿐, 웹 시험 없음. 막힌 요청 내용 없음은 `app.test.ts` 있음 |
| 02 | 라우팅 경계 | 10일 차 | 단위 시험(되묻기)만, 골든셋 없음 |
| 03 | plan 한 번만 실행 | 있음 | `plans.test.ts`, `rooms.test.ts`(PGlite, M1) |
| 03 | 만료 뒤 다시 찾기 | 있음 | `plans.test.ts`, `rooms.test.ts` |
| 03·04 | 게시 확인 한 번 | 있음 | `board.test.ts` "[ADR-03·04 시험]" |
| 04 | 묻기에서 판 쓰기 불가 | 일부 | DB 역할 분리는 없고(`001_base.sql` 끝 "다음에 할 것") 초안의 읽기 전용 트랜잭션 시험으로 대신해요. 다른 모듈 `ask()`는 그 트랜잭션 밖이에요 |
| 06 | 동시 확정·빈 방 없음 | 있음 | `rooms.test.ts:320`(PGlite 직렬, M1) |
| 06 | 예약자 비노출 | 있음 | `rooms.test.ts` "[F2-9 완료]", MCP 출력 시험 |
| 07 | 불변식 I1~I8 | 일부 | 무작위 섞기 시험 있음. PGlite 직렬이라 진짜 병렬 아님(M1), 주문안 확정과의 경쟁 없음(M2·M3) |
| 08 | 주문안 규칙 | 있음 | `plan.test.ts`, `plan-compare.test.ts`(highs-js 800개), `order.test.ts`, `explain.test.ts` |
| 09 | 근거 | 10일 차 | 단위 시험(근거 없는 카드 0건)은 있음 |
| 09 | 사람 이름·기록 칸 | 있음 | `chart-csv.test.ts`, `navi.test.ts` "[F1 완료 기준·D9]", "[ADR-09 시험]" |
| 05·13 | 역할 × 동작 | 있음 | `board.test.ts`, `order.test.ts`, `navi.test.ts` |
| 01·10 | 모듈 허용 목록 | 일부 | `toolsForModule()` 함수 시험만, 쓰는 곳 없음. LLM 입력 스냅샷 없음 |
| 12 | 끄기 스위치 | 일부 | 서버 쪽 있음. 웹 시험 없음, 예시 칩 안 숨겨짐(L7) |
| 13 | 퇴사·세션 | 있음 | `app.test.ts` "[ADR-13 시험]" 둘 |
| 13 | 요청 횟수 | 일부 | `/api/ask` 429 없음 |
| 15 | MCP 인가 | 있음 | `oauth.test.ts` |
| 15·13 | MCP 폐기·퇴사 | 있음 | `oauth.test.ts` "[MCP-5]" 다섯 |
| 14·10 | MCP 출력·경로 | 있음 | `mcp-route.test.ts` |
| 14 | 앱 확인 링크 | 있음 | `rooms.test.ts` "[M3]", `integration.test.ts` |
| 12·14·15 | MCP 스위치·계약 전 잠금 | 있음 | `policy.test.ts`, `oauth.test.ts` "계약 전 잠금" |
| 03·09 | 주입 | 10일 차 | 없음 |
| 10 | 감사 로그 형식 | 일부 | 칸 거절은 있음(`core.test.ts` "[R11]"). 10명 미만 묶음 통계 기능·시험 없음 |

## PRD 완료 기준에서 어긋난 것

- F1 "질문 카나리가 DB·로그·…·URL에서 0건": 묻기만 하면 DB 0건이지만, 탕비실로 가서 이름을 고쳐 올리면 DB에 남아요(H2). 로그·URL 시험은 없어요. Fastify 요청 로그에는 방법·주소·상태만 남는 것을 탐침으로 확인했어요.
- F1 "서버가 받은 본문에 이메일·IP 원형 0건": 웹 시험이 없어요. 서버가 같은 규칙으로 다시 가리긴 해요.
- F3 "묻기에 넣은 카나리가 판·DB에서 0건": H2와 같은 이유로 게시 흐름에서 깨져요.
- F3 "무작위 병렬 불변식": PGlite에서만 확인돼요(M1). 주문안 확정이 끼면 I6가 깨질 수 있어요(M2).
- MCP 완료 기준: 시험이 모두 있어요. 퇴사 차단 시간 기록 시험도 있어요.
- F1 정답률 표·시연 시나리오: 10일 차 몫이라 이번엔 보지 않았어요.

## 확인한 것(문제 없음)

- CSRF: 로그인한 쓰기 경로는 모두 `guards.user`를 거쳐 GET이 아니면 `x-csrf-token`을 봐요(HEAD도 막힘). CORS 머리를 주지 않아요. 예외는 모의 로그인(M4)과 클라이언트 인증을 쓰는 `/oauth/token`·`/oauth/revoke`, Bearer를 쓰는 `/mcp`예요.
- 남의 자원: plan 확인(가명 ID 조건부 UPDATE), 제안 토큰(주인 검사), 예약 취소(`pseudonym_id` 조건), 표·거두기(내 층·내 표), 분장표(부서), MCP 연결 목록·끊기(가명 ID) 모두 서버가 다시 봐요. 총무 경로는 경로 가드와 서비스 안 `requireFacilities` 두 겹이에요.
- 오류 응답·감사 로그: 입력값을 넣는 오류 문구는 없어요. 감사 로그 결과 칸은 모두 상수·개수예요. `/ask` 잠금 응답의 `locks`에는 종류·문구만 있어요.
- 투표자·예약자 비노출: 판·내 요청·제안함·주문안·내보내기 응답에 표 수만 있어요. 장부 어댑터 타입에 예약자·제목 칸이 없어요.
- 회의실: 겹침 제약 + `on conflict do nothing`(제외 제약에 쓸 수 있음), 확인된 plan 없는 앱 예약을 막는 트리거, plan 조건부 UPDATE가 맞아요.
- MCP 인가: 봉인 토큰(AES-GCM, 접두어를 AAD로), `aud`·`iss`·만료·승인 ID 요청마다 검사, PKCE S256·resource 필수, 정확한 리디렉트 URI, 동적 등록 없음, 갱신 회전 조건부 UPDATE, 재직 재확인 창 계산(접근 토큰 수명 + 재사용 창 ≤ 재확인 간격), 도구마다 범위 재확인이 맞아요. `/mcp`는 LLM을 부르지 않고 감사 로그 말고 쓰지 않아요.
- 웹: 원문은 POST 본문과 컴포넌트 상태에만 있어요. URL에는 봉인한 동의 요청과 제안 토큰(L3)만 가요. 입력 칸은 자동 완성이 꺼져 있고, 브라우저 저장소·`dangerouslySetInnerHTML`을 쓰지 않아요. 링크 주소는 서버가 http(s)·mailto만 받아요.
- 화면설계 "보안이 보이는 문구" 표의 문구가 코드에 모두 있어요(끊기 시트는 앱 이름을 넣어 같은 문장).
