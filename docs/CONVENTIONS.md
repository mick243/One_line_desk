# 코드 컨벤션

이 문서는 사람과 에이전트가 같이 지켜요. 기획 근거는 `docs/PRD.md`·`docs/ADR.md`, 꼭 지킬 선은 `CLAUDE.md`예요. 이 문서와 PRD·ADR이 부딪히면 PRD·ADR을 따르고 이 문서를 고쳐요.

## 1. 도구

| 무엇 | 도구 | 명령 |
|---|---|---|
| 언어 | TypeScript(엄격 모드, ESM), Node 22 이상 | |
| 형식 | Prettier(`.prettierrc.json`: 160자, 작은따옴표, 세미콜론, 끝 쉼표) | `npm run format` / `npm run format:check` |
| 린트 | `tsc` 엄격 옵션(안 쓰는 변수·매개변수, 빠진 return, switch 흘러내림 금지) + 규칙 시험(아래 8절) | `npm run typecheck` |
| 시험 | Vitest | `npm test` |
| 한 번에 | 형식 → 타입 → 시험 | `npm run check` |

- ESLint·Biome은 쓰지 않아요. TypeScript 7에는 typescript-eslint가 쓰는 API가 없고, Biome 실행 파일은 이 PC의 Windows 앱 제어 정책에 막혀요.
- 의존성 추가는 리드(메인 세션)만 해요. 에이전트는 필요하면 보고에 적어요.

## 2. 폴더

```
packages/shared/src/        브라우저·서버가 같이 쓰는 것
  input-check/              공통 입력 검사 규칙(ADR-11). 하나뿐이에요
  api/<kind>.ts             모듈별 요청·응답 타입
apps/server/src/
  core/                     공통 바닥: db/, ai/, 세션, 감사 로그, 제안 토큰, plan, 라우터, 도구 레지스트리, 운영 설정
  modules/<kind>/           navi · notices · rooms · pantry · mcp
    index.ts                DeskModule 객체 하나를 export
    routes.ts · service.ts · repo.ts · *.test.ts · fixtures/
  routes/                   공통 경로(auth, ask, plans, config)
apps/web/src/
  components/               공통 화면 부품(카드, 시트, 입력 칸)
  screens/                  S1~S6 껍데기
  modules/<kind>/           모듈 화면 부품(S3·S4·S5, S6 칸, 모듈 카드 그리기)
db/migrations/              NNN_<영역>_<무엇>.sql
```

- **모듈 경계**: `modules/<a>/`는 `modules/<b>/`를 import하지 않아요. 다른 모듈의 기능이 필요하면 `core/services.ts`의 인터페이스를 거쳐요(ADR-01). 규칙 시험이 막아요. 모듈이 가져올 수 있는 것은 `core/*`, `context`, `adapters/types`, `@one-line-desk/shared`, 자기 폴더예요.
- 마이그레이션 번호는 영역마다 나눠 써요: `0xx` 공통 · `1xx` navi · `2xx` notices · `3xx` rooms · `4xx` pantry · `5xx` mcp. 이미 적용된 파일은 고치지 않고 새 파일을 더해요.

## 3. 이름

| 대상 | 규칙 | 예 |
|---|---|---|
| 파일 | kebab-case, React 컴포넌트만 PascalCase | `proposal-token.ts`, `CardView.tsx` |
| 타입·인터페이스·컴포넌트 | PascalCase | `DeskModule`, `PlanSheet` |
| 함수·변수 | camelCase, 동사로 시작 | `findFreeRooms`, `isPantryStandalone` |
| 상수 | UPPER_SNAKE | `SESSION_MAX_AGE_MS` |
| DB 표·칸 | snake_case, 표는 복수형 | `room_reservations.pseudonym_id` |
| API 경로 | `/api/<모듈>/<자원>` kebab-case | `/api/rooms/my-reservations` |
| 도구 이름 | `<모듈>_<동작>` snake_case | `rooms_find_free` |
| 모듈 종류 코드 | `navi · notices · rooms · pantry · unknown` | 한글은 담당·공지·회의실·탕비실·모름 |

## 4. TypeScript

- `any`를 쓰지 않아요. 바깥에서 온 값(요청 본문, LLM 출력, 파일)은 경계에서 검증해요: 서버 경로는 Fastify JSON 스키마, LLM·파일은 `zod`.
- `import type`으로 타입만 가져와요(`verbatimModuleSyntax`).
- 상대 경로 import는 확장자를 붙이지 않아요.
- 시간은 `ctx.now()`로만 읽어요. `Date.now()`를 모듈 안에서 직접 부르지 않아요(시험에서 시계를 돌려요).
- 오류는 `DeskError(code, status, message)`로 던지고 경로에서 `{ error, message }`로 바꿔요. 메시지는 해요체 화면 문구예요.

## 5. 서버

- 경로마다 Fastify JSON 스키마로 본문을 검증하고 `additionalProperties: false`를 둬요.
- 로그인한 경로는 `requireSession`을 거쳐요. 역할은 `rolesOf()`로 요청마다 계산해요(R17).
- 쓰기는 세 길뿐이에요(ADR-03, R2): 확인 시트(plan) · 공개 미리보기(바로 실행 plan) · 고정 버튼(`runFixedAction`). 그 밖의 길로 DB에 쓰지 않아요.
- SQL은 `repo.ts`에만 둬요. 값은 늘 매개변수(`$1`)로 넘기고 문자열을 이어 붙이지 않아요.
- 응답에 사람 이름(남의 예약자, 분장표 담당자)·투표자·질문 원문을 넣지 않아요.
- 감사 로그는 `ctx.audit.record()`로만 남기고 내용 칸은 없어요.
- LLM은 `ctx.gateway`로만 불러요. 등급은 데이터를 준 어댑터의 `mock` 여부로 정해요(모의 = 등급 0).

## 6. 웹

- 화면 문구는 해요체이고 `docs/화면설계.md`의 문구를 그대로 써요. 버튼은 `[예약하기]`처럼 동사로 끝내요.
- 카드는 공통 `CardView`(다섯 칸)로 그려요. 머리 라벨은 글자로 보여 주고 색만으로 가르지 않아요.
- 입력 원문은 컴포넌트 상태(페이지 메모리)에만 둬요. `localStorage`·`sessionStorage`·URL·IndexedDB에 넣지 않아요(R13).
- 색·간격은 `styles.css`의 CSS 변수만 써요. 컴포넌트에 색 값을 직접 쓰지 않아요.
- 폰 너비·한 손 기준이에요. 주 버튼과 입력창은 아래쪽에 둬요. S4·S5는 PC 우선이에요.

## 7. 시험

- 시험 파일은 코드 옆에 `*.test.ts`로 둬요.
- `describe`·`it` 이름은 한국어로 "무엇이 어떻게 돼요"라고 써요. PRD 완료 기준을 지키는 시험은 이름 앞에 기준 번호를 붙여요: `it('[F2-7] 같은 방·구간 동시 확정은 한 명만 성공해요', …)`.
- DB 시험은 `core/db/test-db.ts`의 `createTestDb()`로 시험 파일마다 새 PGlite를 띄워요. 실제 PostgreSQL이 필요한 시험은 `TEST_DATABASE_URL`이 있을 때만 돌려요.
- LLM은 시험에서 `FakeProvider`를 써요. 실제 모델을 부르는 시험은 두지 않아요.

## 8. 규칙 시험(`apps/server/src/core/conventions.test.ts`)

코드를 읽어 아래를 막아요.
- 모듈끼리 import
- 서버 코드의 `console.log`(마이그레이션 스크립트 빼고)
- 웹 코드의 `localStorage`·`sessionStorage`·`indexedDB`
- `dangerouslySetInnerHTML`
- 모듈 안의 `Date.now()`·`new Date()`(시계는 `ctx.now()`)

## 9. git

- 브랜치: `feat/<영역>-<무엇>`, `fix/…`, `docs/…`. main에 바로 올리지 않고 PR로 합쳐요.
- 커밋 메시지: 첫 줄은 해요체 한 줄 요약, 빈 줄 뒤에 바뀐 점을 줄표로 적어요.
- 커밋·push·PR은 사용자가 요청할 때만 해요.
