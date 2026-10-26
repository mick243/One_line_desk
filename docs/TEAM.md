# 에이전트 팀

리드(메인 세션)가 공통 바닥과 약속을 깔고, 모듈 에이전트가 자기 폴더만 맡아 구현해요. 검토 에이전트가 PRD 완료 기준과 ADR 시험 표로 점검하고, 리드가 합쳐요.

## 역할과 맡은 곳

| 에이전트 | 맡는 기능 | 고칠 수 있는 곳 | 마이그레이션 번호 |
|---|---|---|---|
| 리드 | 공통 바닥, 공통 화면(S1·S2·S6 껍데기), 합치기 | `apps/server/src/core`·`routes`·`app.ts`·`context.ts`, `apps/web/src/components`·`screens`·`App.tsx`, `packages/shared`(모듈 파일 빼고), 문서 | `0xx` |
| 담당·공지 에이전트 | F1 담당 카드·"틀렸어요"·S5, 공지 찾기 | `modules/navi`, `modules/notices`(서버·웹), `shared/src/api/navi.ts`·`notices.ts` | `1xx`, `2xx` |
| 회의실 에이전트 | F2 회의실 찾기·확인 예약·취소·내 예약, 앱 확인 링크 다시 조회 | `modules/rooms`(서버·웹), `shared/src/api/rooms.ts` | `3xx` |
| 같이 채워요 판 에이전트 | F3 게시·+1·거두기·상한·같은 상품 표시·총무 합치기/되돌리기/따로 두기, S3, S4 합치기 칸, 내 요청 | `modules/pantry`(서버·웹)에서 `order/` 빼고, `shared/src/api/pantry.ts` | `401`~`449` |
| 주문안 에이전트 | F3 주문안(탐욕법·이유 코드·설명·확정·주기·내보내기), S4 주문안 칸 | `modules/pantry/order`(서버·웹), `shared/src/api/pantry-order.ts` | `450`~`499` |
| MCP 에이전트 | 읽기 전용 MCP: 인가 서버·`/mcp`·도구 둘·동의 시트·S6 연결된 AI 앱·앱 확인 링크 진입 | `modules/mcp`(서버·웹), `shared/src/api/mcp.ts` | `5xx` |
| 검토 에이전트(보안·QA) | PRD 완료 기준·ADR 시험 표·CLAUDE.md 선을 코드와 대조 | 읽기만(`docs/REVIEW.md`만 써요) | |
| 요구사항 추적 에이전트 | 요구사항 → 코드 → 시험 추적표 | 읽기만(`docs/TRACEABILITY.md`만 써요) | |

## 약속(리드가 깔아 둔 것)

- 모듈은 `DeskModule`(`core/module.ts`)을 돌려주는 팩토리 하나를 `index.ts`에서 export해요. 묻기 카드는 `ask()`, 쓰기는 `planHandlers`(확인 시트·바로 실행) 또는 `ctx.fixed.run()`(고정 버튼)이에요.
- 카드는 `core/cards.ts`의 `makeCard()`로 다섯 칸을 채워요. 쓰기 카드에는 `ctx.plans.propose()`로 만든 제안 토큰만 붙여요.
- 모듈 사이 기능은 `core/services.ts`의 인터페이스로만 주고받아요: `rooms`·`notices`·`navi`·`mcp`.
- 같이 채워요 묶음 셈은 `modules/pantry/bundles.ts`의 `listOpenBundles()` 하나예요. 주문안은 이걸 읽기만 해요.
- 웹 모듈 부품은 `apps/web/src/modules/types.ts`의 `WebModules` 약속을 따르고, `modules/registry.tsx`가 모아요.
- 경로 시험은 `apps/server/src/testing.ts`의 `createTestApp()`·`loginAs()`를 써요.

## 진행

1. 리드: 컨벤션(`docs/CONVENTIONS.md`)과 공통 바닥을 깔아요.
2. 모듈 에이전트 다섯을 동시에 돌려요. 각자 자기 폴더만 고치고, 끝나면 형식·타입·자기 시험 결과와 PRD 완료 기준 상태를 보고해요.
3. 리드가 합쳐서 전체 `npm run check`를 돌려요.
4. 검토 에이전트와 추적 에이전트를 동시에 돌려요. 리드가 지적을 고치거나 모듈 에이전트에게 다시 맡겨요.
5. 브라우저에서 핵심 흐름 다섯 개(화면설계 ①~⑤)를 확인해요.

## 지키는 것

- 다른 에이전트의 폴더, 공통 바닥, `package.json`은 고치지 않아요. 필요하면 보고에 적어요.
- 의존성은 이미 깔린 것만 써요: fastify, @fastify/cookie, pg, @electric-sql/pglite, zod, @anthropic-ai/sdk, @modelcontextprotocol/sdk, highs(시험용), react.
- 실제 회사 데이터·실제 사람 이름을 넣지 않아요. 가상 자료(등급 0)만 써요.
- git 커밋·push는 하지 않아요.
