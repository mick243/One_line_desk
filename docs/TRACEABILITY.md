# 요구사항 추적표 — 한 줄 데스크

- 만든 날: 2026-10-26 · 만든 이: 요구사항 추적 에이전트(`.claude/agents/desk-tracer.md`)
- 출처: `docs/PRD.md`, `docs/ADR.md`, `docs/화면설계.md`, `docs/기획서.md`, 결정 번호 뜻은 `docs/회의종합.pdf`(D1~D13 · R1~R18 · M1~M7)
- 범위: 코드는 고치지 않았어요. `npm test`는 돌리지 않았어요(검토 에이전트 몫). 시험은 이름과 본문을 읽어 "무엇을 지키는지"만 판단했어요.

## 요약

추적한 줄은 모두 258개예요.

| 절 | 완료 | 부분 | 다르게 됨 | 없음(일정상 나중) | 없음(코드 밖) | 합계 |
|---|---|---|---|---|---|---|
| 1 PRD F1 | 16 | 1 | 0 | 1 | 0 | 18 |
| 2 PRD F2 | 14 | 1 | 0 | 0 | 0 | 15 |
| 3 PRD F3 | 21 | 0 | 1 | 0 | 0 | 22 |
| 4 MCP 읽기 채널 | 13 | 1 | 1 | 0 | 0 | 15 |
| 5 비기능·보안 | 8 | 4 | 1 | 1 | 1 | 15 |
| 6 ADR-01~15 | 11 | 4 | 1 | 0 | 0 | 16 |
| 7 ADR 시험 표 | 18 | 5 | 1 | 3 | 0 | 27 |
| 8 D1~D13 | 13 | 0 | 0 | 0 | 0 | 13 |
| 9 R1~R18 | 16 | 1 | 0 | 1 | 0 | 18 |
| 10 M1~M7 | 6 | 0 | 1 | 0 | 0 | 7 |
| 11 화면 S1~S6·카드·시트 | 32 | 10 | 3 | 0 | 0 | 45 |
| 12 핵심 흐름 ①~⑤ | 4 | 1 | 0 | 0 | 0 | 5 |
| 13 보안이 보이는 문구 | 29 | 1 | 0 | 0 | 0 | 30 |
| 14 2주 일정 | 8 | 1 | 0 | 2 | 1 | 12 |
| **합계** | **209** | **30** | **9** | **8** | **2** | **258** |

- 코드가 통째로 없는 "없음" 줄은 0개예요. 빠진 기능은 모두 "부분" 줄 안에 있어요(예: 운영자 묶음 통계, 설정값 바꾸기, MCP 클라이언트 등록).
- 보안 문구 30줄: 웹 코드에 글자가 그대로 있는 줄 17, `packages/shared` 상수로 웹이 그리는 줄 8, 서버 카드·시트 문구로 내려오는 줄 4, 웹·shared 어디에도 없는 줄 1("보안을 위해 다시 로그인해 주세요", 서버 401 메시지에만 있음).
- 시험(`it`) 269개 중 이름 앞 표시가 붙은 214개(표시 붙은 `describe` 9개)를 먼저 이었어요. 웹 시험은 0개라 화면 줄은 시험 칸이 비어 있어요.

**빠진 것 상위 10개**(자세한 건 15절)

1. 판 요청 글·같은 상품 판정·주문안 설명을 LLM에 등급 0으로 못 박아 보내요. 실제 모델로 켜면 무보관 계약 전에도 직원 문장이 나가요(ADR-10·R6, 다르게 됨).
2. (10/26 해결) 주문안 "채울 수 있는 입력에서 못 받은 층 0건": 사용자 결정(D8 1단계 보정)으로 1단계에 정확한 채움 확인을 넣었어요. 무작위 800개에서 0건이고 시험이 실패로 막아요.
3. 끄기 스위치를 웹이 덜 따라요: 꺼진 모듈의 예시 칩, S4·S5 진입점(단독 모드 S5 포함)이 보여요(R4·ADR-12).
4. 운영 설정값(회의 길이·만료·횟수 상한·재확인 간격)을 운영자가 바꾸는 경로와 그 감사 로그가 없고, 설정이 서버 메모리에만 있어요(F2-1·ADR-12).
5. DB 읽기 역할 분리가 없어요(묻기·초안 경로 역할, 운영자의 투표 표·승인 토큰 해시 읽기 금지)(ADR-04·10).
6. 원문 카나리 시험이 DB·브라우저 저장소뿐이에요. 앱 로그·오류 응답·URL·자동 완성 꺼짐 시험이 없어요(F1 완료3, 2일 차 기준).
7. 운영 표 중 10명 이상 묶음 통계·오류 표·MCP 거부 이유별 셈이 없어요(PRD 운영자, ADR-10).
8. 보안팀 승인 MCP 클라이언트를 운영자가 등록하는 경로가 없어요(시연 클라이언트 seed만)(MCP 요구4·ADR-15).
9. 세션 만료 문구가 웹에 없어 첫 화면 401에서 안 보여요(보안 문구 표).
10. 바닥 시트가 브라우저 뒤로 가기·아래로 밀기로 닫히지 않아요(PRD 접근성·S2).

## 읽는 법

- 상태
  - **완료**: 문서가 바라는 대로 코드가 있고, 대부분 시험도 있어요.
  - **부분**: 일부만 있거나, 코드는 있는데 문서가 요구한 시험이 빠졌어요.
  - **없음**: 코드가 없어요. `없음(일정상 나중)`은 2주 일정에서 아직 때가 아닌 것(10일 차 측정·다음 2주로 미룬 것)이에요. `없음(코드 밖)`은 보안팀 승인·배포 설정처럼 저장소 밖의 일이에요.
  - **다르게 됨**: 문서와 코드가 달라요. 어느 쪽이 맞아 보이는지 메모에 적었어요.
- 줄인 경로: `S/` = `apps/server/src/`, `W/` = `apps/web/src/`, `P/` = `packages/shared/src/`, `D/` = `db/migrations/`
- 시험 칸은 `파일:줄 [표시] 이름 앞부분`이에요. 시험 이름 앞 표시(`[F2-…]`, `[ADR-… 시험]`, `[MCP-n]`, `[R1]`, `[I1]` 등)를 먼저 grep으로 모아 이었고(`it` 269개 중 표시 붙은 것 214개), 표시가 없는 요구는 코드를 읽어 판단했어요.
- 웹 시험(`*.test.tsx`)은 하나도 없어요. 화면 쪽 줄은 코드를 읽어 판단했고 시험 칸이 비어 있어요.

---

## 1. PRD F1 묻고 근거 카드 받기

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| F1-1 | 입력창은 S1에만, 머리 "나만 보여요", 안내 문구, 예시 칩 3개는 채우기만 | 완료 | W/screens/Ask.tsx:10, :45-51, :54-63 | 없음(웹 시험 없음) | 꺼진 모듈의 예시 칩을 숨기지 않아요(→ 6절 ADR-12, 11절 S1) |
| F1-2 | 보내기 전 공통 검사: 키·토큰 잠금, 이메일·IP 가림(풀기 없음), 등급 3·건강 정보 막고 이유, 가림 줄 | 완료 | P/input-check/rules.ts:14-43, P/input-check/check.ts:12-43, W/components/CheckedInput.tsx:22-32, :57-61, S/routes/ask.ts:28-32 | P/input-check/check.test.ts:12 이메일과 IP는 가린 뒤 보내요, :20 키·토큰 it.each, :30, :39 · S/app.test.ts:42 [ADR-10·11 시험] | 브라우저·서버가 같은 `checkInput`을 import해요 |
| F1-3 | 공통 검사 → 규칙 → LLM 한 번 `{종류, 슬롯, 애매함}`, 확신 낮으면 칩 최대 3 + "다른 거예요", 모름·다른 거예요 → 담당 안내 | 완료 | S/core/router.ts:14-26, :50-86, S/core/router-rules.ts:5-15, W/components/ResultSheet.tsx:49-60 | S/core/router.test.ts:44, :49, :57, :62 [ADR-02 시험] 경계 문장은 칩으로 되물어요, :69, :74 [ADR-02] | 확신이 높을 때 칩은 눌러 바꿀 수 없어요(→ 11절 카드 문법) |
| F1-4 | 담당 카드: 후보 행 하나 또는 없음, 행 원문(팀·창구, 할 일, 기간, 근거 행·개정일), 사람 이름 없음, 기간 비면 "분장표에 없음" | 완료 | S/modules/navi/service.ts:55-115(rankRows·pickRow), :203-211, S/modules/navi/cards.ts:9, :26-52 | S/modules/navi/navi.test.ts:53 [F1-4], :79 [F1-4], :223, :242, :251 | LLM 스키마에는 행 ID 대신 후보 번호만 넣어요(ADR-10 "스키마에 사내 정보 없음"에 맞춤) |
| F1-5 | `없음`이면 "여기로 물어보세요"(총무 창구), 못 찾은 건수는 감사 로그 결과 "못 찾음"으로만 | 완료 | S/modules/navi/cards.ts:55-66, S/core/router.ts:84 | navi.test.ts:98 [F1-5] | 운영자 묶음 통계는 없어요(→ 5절 비기능 역할 표) |
| F1-6 | IT 질문은 IT 창구 + 헬프데스크 링크 담당 카드, 해결 단계 없음 | 완료 | S/modules/navi/fixtures/chart.csv, S/modules/navi/cards.ts:27 | navi.test.ts:87 [F1-6] · chart-csv.test.ts:34 | |
| F1-7 | 공지는 허용 게시판 사본에서 규칙·색인으로, 제목·게시일·원문 링크만, 요약 없음 | 완료 | S/modules/notices/service.ts:27-31, :37-53, :69-96, D/201_notices_base.sql, P/switches.ts:31 | S/modules/notices/notices.test.ts:32 [F1-7], :61 [F1-7], :78 [ADR-14 시험], :88 [ADR-10] | 공지 본문은 DB에 없고 색인 조각만 있어요 |
| F1-8 | "틀렸어요" 넷, 기록은 (예측 종류, 고친 종류, 예측 행, 고른 행, 이유, 시각)만, ID 없음, 따로 된 피드백 경로, 자유 문장 없음, 칩 바꾸면 같은 문장 | 완료 | W/modules/navi/WrongSheet.tsx:20-166, S/modules/navi/routes.ts:29-73, S/modules/navi/service.ts:121-123, :225-246, D/001_base.sql:124-132 | navi.test.ts:261 [F1 완료 기준], :282 [ADR-09 시험], :292, :309 [F1-8] | 시각을 날 단위(한국 0시)로 줄여 남겨요. 문서보다 더 안전해서 코드가 맞아 보여요. PRD F1-8·ADR-09에 "날짜"로 적어 두길 권해요 |
| F1-9 | S5: 자기 부서 행 기록 묶음, 파일 다시 올리기(확인 시트)로만 반영, 자동 반영 없음, 행 고치기는 다음 2주 | 완료 | S/modules/navi/service.ts:160-184, :249-275, :295-318, S/modules/navi/routes.ts:91-140, W/modules/navi/ChartScreen.tsx:26-101, :104-259 | navi.test.ts:339 [F1 완료 기준·R9], :376 [F1-9], :403, :414, :439 [F1-9], :447 [F1-9·R9], :495 | |
| F1-10 | 탕비실 의도면 F3 공개 미리보기로 | 완료 | S/modules/pantry/service.ts:121-154, :165-169 | S/modules/pantry/board.test.ts:52 [F3-완료1] · S/core/router.test.ts:57 | |
| F1-11 | 같은 공지 찾기를 MCP `notices_search`로 | 완료 | S/modules/notices/index.ts:9, S/modules/mcp/mcp-route.ts:44-140 | notices.test.ts:106 [MCP 완료 기준], :120, :130 · S/modules/mcp/mcp-route.test.ts:57 [MCP-3], :152 [MCP-3] | |
| F1 완료1 | 근거 행 없는 담당 카드 0, 원문 링크 없는 공지 카드 0, 공지 카드 본문·요약 0 | 완료 | 위 F1-4·F1-7 | navi.test.ts:117 [F1 완료 기준] · notices.test.ts:32 | 가상 분장표·공지 기준이에요 |
| F1 완료2 | 사람 이름 칸 분장표를 가져와도 이름이 DB·응답·화면 0 | 완료 | S/modules/navi/chart-csv.ts:1-30 | navi.test.ts:509 [F1 완료 기준·D9] · chart-csv.test.ts:16 [D9], :58 | 화면은 응답만 그려서 따로 시험하지 않았어요 |
| F1 완료3 | 질문 카나리가 DB·로그·오류 보고·프록시 로그·브라우저 저장소·URL 0 | 부분 | S/app.ts:74-84, W/api.ts:44-53(POST 본문만) | S/app.test.ts:54 [ADR-10 시험] DB 전체, navi.test.ts:192, board.test.ts:52 · S/core/conventions.test.ts:48 [R13] 브라우저 저장소 | DB·브라우저 저장소(코드 규칙)만 시험해요. 앱 로그·오류 응답·URL 카나리 시험이 없어요. 프록시는 배포 설정 몫 |
| F1 완료4 | 키·토큰 시험 문자열 전부 잠김, 서버 본문에 이메일·IP 원형 0 | 완료 | W/components/CheckedInput.tsx:32(가린 글만 보냄), S/routes/ask.ts:28-33 | check.test.ts:20, :12 · app.test.ts:42 | `sk-` API 키 규칙은 시험 목록에 없어요(작음) |
| F1 완료5 | 주인이 다시 올리기 전 반영 0, 다른 부서 행 파일·주인 아닌 사람 올리기 거부 | 완료 | S/modules/navi/service.ts:118, :160-184 | navi.test.ts:339, :403, :414 | |
| F1 완료6 | "틀렸어요" 기록에 ID 0, 묻기 감사 로그에 행 ID·공지 ID·슬롯 0 | 완료 | S/core/audit.ts:4-38, S/core/router.ts:65-84 | navi.test.ts:261, :173 [F1 완료 기준·ADR-10] · router.test.ts:87 [R11] · core.test.ts:72 [R11] | |
| F1 완료7 | 정답 질문 30~50건 담당 정답률·라우터 경계 문장 표("가상" 표기) | 없음(일정상 나중) | — | — | 10일 차 측정이에요. 골든셋·측정 스크립트가 아직 없어요 |

## 2. PRD F2 회의실 찾고 확인 예약

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| F2-1 | 날짜·시작·길이·인원·장비·층 조건 칩, 고칠 수 있음, 빠진 값 되묻기, 길이 기본값은 운영 설정이고 운영자만 바꿈 | 부분 | S/modules/rooms/service.ts:59-68, :83-86, S/modules/rooms/cards.ts:23-35, P/api/rooms.ts:86-119, W/modules/rooms/RoomConditionsCard.tsx:13-124 | S/modules/rooms/rooms.test.ts:101 [F2-1·F2-2], :132 [F2-1], :147, :182 · search.test.ts:92 | 칩·되묻기·기본값은 있어요. 운영자가 기본 길이 같은 설정값을 바꾸는 경로가 없어요(`S/core/ops-settings.ts:28` `patchValues`는 시험용이고 감사 로그도 없음) |
| F2-2 | 후보 최대 3장, "현황 HH:MM 기준", 맞은 조건 | 완료 | S/modules/rooms/search.ts(searchSlots), S/modules/rooms/cards.ts:17, :38-56 | search.test.ts:20 [F2-2] · rooms.test.ts:101 | |
| F2-3 | 처음부터 빈 방 없음 → 안내 카드 + 대안 최대 2 / 대안도 없으면 "대안 없음" + 조건 고치기 | 완료 | S/modules/rooms/cards.ts:58-71, S/modules/rooms/service.ts:146-154 | rooms.test.ts:154 [F2-3], :173 [F2-3] · search.test.ts:27, :38 [ADR-06 시험], :71 | |
| F2-4 | 카드엔 서명된 짧은 수명 제안 토큰만, `/ask` 저장 없음, [이 방으로 예약] → plan + 확인 시트, [예약하기]는 plan_id만, 누르면 잠김 | 완료 | S/modules/rooms/service.ts:110-120, :226-240, S/core/plans.ts:53-95, S/routes/plans.ts, W/components/ActionHost.tsx:68-77, :140-167 | rooms.test.ts:200 [F2-4], :210 [F2-4·F2-7] · S/core/plans.test.ts:88, :135 [ADR-03 시험] | |
| F2-5 | 실행 순간 세션·권한 재검사, 만료면 같은 조건으로 다시 찾고 "시간이 지나 다시 찾았어요", DB 겹침 제약, 멱등 키 plan_id | 완료 | S/core/plans.ts:28, :73-95, :188-202, S/core/guard.ts:20-44, D/001_base.sql:43-51, D/300_rooms_ledger.sql:4-31 | plans.test.ts:100, :108, :118 [ADR-03 시험] · rooms.test.ts:251, :283 [F2 완료·ADR-06 시험], :302 [F2-5 완료], :598 [M3·F2-5] | 확인된 plan 없는 앱 예약을 DB 트리거도 막아요 |
| F2-6 | 막힘은 실행 재검사에서만, "확인하는 사이에 다른 예약이 들어왔어요" + 대안 최대 2, 조건 칩 그대로 | 완료 | S/modules/rooms/cards.ts:74-94, S/modules/rooms/service.ts:241-267 | rooms.test.ts:313 [F2-6 완료·ADR-06 시험], :350 [F2-6] | 막힘 결과는 앞 결과 시트(조건 칩) 위에 겹쳐 떠서 칩이 아래에 남아요. 막힘 이유 코드(`P/cards.ts:8` BLOCKED_REASONS)는 정의만 있고 카드에 실리지 않아요(작음) |
| F2-7 | 결과 카드 "HH:MM에 다시 확인하고 예약했어요" + 취소, 취소도 확인 시트, 내 예약은 S1·S6 | 완료 | S/modules/rooms/cards.ts:97-146, S/modules/rooms/service.ts:274-305, W/modules/rooms/index.tsx:15-76, W/screens/Ask.tsx:42, W/screens/Mine.tsx:34 | rooms.test.ts:210, :387 [F2-7] | |
| F2-8 | 하루 안 한 구간, 내 이름으로 한 건, 반복·여러 날·대리·초대 없음 | 완료 | S/modules/rooms/search.ts:33(ReserveParamsSchema) | search.test.ts:97 [F2-8], :109 [F2-8] | |
| F2-9 | 남의 예약은 "예약됨"만, 어댑터 출력 타입에 예약자·제목 칸 없음 | 완료 | S/modules/rooms/ledger-adapter.ts:23-28, :41-47, P/api/rooms.ts:15-23 | rooms.test.ts:441 [F2-9 완료], :471 [F2-9·ADR-06 시험] | |
| F2-10 | 스위치: 링크만 → "이 일은 그룹웨어에서 해요" 카드, 회의실 쓰기 끔 → 주 버튼 "그룹웨어에서 예약하기" | 완료 | S/core/router.ts:77-80, :136-147, S/modules/rooms/service.ts:54-56, :110-114 | rooms.test.ts:490 [F2-10], :509 [F2-10] · router.test.ts:79 [R4] | `/api/rooms/search`·`recheck`는 rooms가 '끔'이어도 링크 카드를 줘요(문서: 끔이면 담당 안내). 화면에선 거의 안 닿는 길이라 작음 |
| F2-11 | `rooms_find_free` MCP로도, 링크로 와도 확인 한 번 | 완료 | S/modules/rooms/service.ts:158-221, S/modules/mcp/mcp-route.ts:185-215 | rooms.test.ts:621 [F2-11·ADR-14 시험], :650 [F2-11] · S/modules/mcp/integration.test.ts:24 [MCP-6] | |
| F2 완료1 | 모든 예약 행 plan_id가 확인된 plan, plan 없이·남의·만료 plan으로 예약 0 | 완료 | D/300_rooms_ledger.sql:4-31 | rooms.test.ts:251, :283, :368 [F2 완료·ADR-03 시험] | |
| F2 완료2 | 동시 확정 한 명만, 다른 한 명은 막힘 + 대안 최대 2(없으면 "대안 없음") | 완료 | D/001_base.sql:50 | rooms.test.ts:313, :350 | |
| F2 완료3 | 같은 plan_id 두 번 → 예약 1, 남의 예약자·제목 0 | 완료 | S/core/plans.ts:73-95 | rooms.test.ts:302, :441 | |
| F2 완료4 | 시연 시나리오: 조건 부족·빈 방 없음·만료 뒤 다시 찾기·취소·스위치 | 완료 | 위 줄들 | rooms.test.ts:132, :154, :598, :387, :490, :509 · plans.test.ts:118 | 시험 단위로는 다 있어요. 브라우저 리허설 기록은 없어요(TEAM.md 5단계) |

## 3. PRD F3 같이 채워요

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| F3-1 | 층별 판, 머리 "우리 층 모두에게 보여요", 같은 공통 검사, 내 층에서만 투표, 표 많은 순 → 최근 순 | 완료 | W/modules/pantry/BoardScreen.tsx:16-114, S/modules/pantry/routes.ts:30-55, S/modules/pantry/service.ts:317-325, S/modules/pantry/bundles.ts:62 | board.test.ts:247 [F3-완료5] 다른 층 +1 거부 | 정렬 순서를 지키는 시험은 없어요 |
| F3-2 | 공개 미리보기가 곧 확인, 이름 고치고 [올리기] → plan 만들기+실행 한 번, [올리지 않기]면 남는 것 없음, 품목 이름만, 문구, 기본 선택 없음 | 완료 | W/modules/pantry/PreviewCard.tsx:15-95, S/modules/pantry/cards.ts:14-26, S/core/plans.ts:98-142 | board.test.ts:81 [F3-완료2], :96 [ADR-03·04 시험], :113 [ADR-03·04 시험] · plans.test.ts:142 [R2] | |
| F3-3 | 실행 직전 서버 재검사(등급 3·전화·이메일·사람 이름), 건강 정보 막음, 비슷한 품목이면 [여기에 +1] | 완료 | S/modules/pantry/service.ts:182-256, P/api/pantry.ts:56-85 | board.test.ts:121 [F3-3], :134 [F3-3], :155 [F3-3], :174 [F3-3] · similarity.test.ts:48 [F3-3], :54 [F3-3] | |
| F3-4 | 판에 담당 질문 → "이건 담당 안내가 맞아 보여요" + [묻기로 옮기기], 글은 앱 메모리로만 | 완료 | S/modules/pantry/cards.ts:94-104, S/modules/pantry/service.ts:157-162, W/modules/pantry/BoardScreen.tsx:55-60, W/App.tsx:29, :85-88 | board.test.ts:195 [F3-4] | |
| F3-5 | 묶음마다 1인 1표, 올리면 내 표 1개, 상한 = 열린 묶음 중 내 표 묶음 수(+1·게시 순간만), 합치기 풀려 넘침 문구, 횟수 제한, 투표자 비노출 | 완료 | S/modules/pantry/service.ts:228-229, :245, :270-292, S/modules/pantry/bundles.ts:130 | board.test.ts:260 [F3-5], :284 [F3-완료4], :313 [R14], :227 [ADR-12·13] · invariants.test.ts:182 [F3-완료4·I7] | |
| F3-6 | AI 합치기·카탈로그 매칭 제안, 게시 순간 같은 층 열린 품목과 비교, S4 열 때 한 번 더, 같은 층 기존 요청만 | 완료 | S/modules/pantry/similarity.ts:151-224, S/modules/pantry/service.ts:139, :247-254, :477-507 | board.test.ts:405 [F3-6·7] · similarity.test.ts:28, :35 | 게시 실행(plan 트랜잭션)에서는 LLM을 못 불러서 AI 비교를 초안 때 하고 결과를 토큰(aiSeen)에 담아요. R15 취지와 같아요 |
| F3-7 | 확정 전엔 "같은 상품 같아요" 표시만, 표는 안 합침 | 완료 | W/modules/pantry/BoardScreen.tsx:141-145, S/modules/pantry/service.ts:339-346 | board.test.ts:405 [F3-6·7] | |
| F3-8 | 합치기 확정·되돌리기는 총무만 S4에서, [합치기]·[되돌리기]는 확인 시트, [따로 두기]는 바로 | 완료 | S/modules/pantry/routes.ts:27, S/modules/pantry/service.ts:510-598, W/modules/pantry/MergePanel.tsx:57-92 | board.test.ts:386 [F3-완료5], :405, :428 [F3-8·10] | |
| F3-9 | 묶음 표 = 서로 다른 사람 수, 표는 원 카드에, 합친 뒤 새 표는 대표에, 거두면 묶음 안 내 표 모두 | 완료 | S/modules/pantry/bundles.ts:28-62, S/modules/pantry/service.ts:287-303 | board.test.ts:347 [F3-9] · bundles.test.ts:34 [I1] · invariants.test.ts:201 [I4], :253 [I3] | |
| F3-10 | 표는 버전 안 올림, 409는 다른 총무가 먼저 바꿨을 때만, 직원 판은 몇 초마다 새로고침 | 완료 | S/modules/pantry/service.ts:287, :510-543, W/modules/pantry/BoardScreen.tsx:14, :41-44 | invariants.test.ts:217 [R3·I8] · board.test.ts:428 | 5초마다 새로고침해요 |
| F3-11 | 예산·층별 최소 몫, 묶음 단위, 다른 층 몫 남기는 탐욕법, 예산 < 최소 몫 합이면 경고+확정 잠금, 요청 모자란 층은 경고만 | 완료 | S/modules/pantry/order/plan.ts:112-245, S/modules/pantry/order/service.ts:112-130 | plan.test.ts:37, :64, :70, :89, :98, :112, :120 [R1] · order.test.ts:103, :192 [R1] | 탐욕법이 못 채우는 입력이 있어요(→ F3 완료6) |
| F3-12 | 줄마다 이유 코드 칩 + 한 문장, LLM엔 줄 ID·이름·층·표·금액·이유·순위만, 숫자 다르면 틀 문장 | 완료 | S/modules/pantry/order/explain.ts:25-131, W/modules/pantry/order/index.tsx:320-340 | explain.test.ts:29, :49, :55, :62, :94, :102 [ADR-08] · order.test.ts:126 [ADR-08] | |
| F3-13 | 총무가 줄을 빼거나 바꾸면 검사 재실행, 틀 문장 + "총무가 고침", 예산 넘으면 잠금, 최소 몫 미달은 경고만, 확정하면 파일 내보내기 | 완료 | S/modules/pantry/order/service.ts:153-198, :252-264, S/modules/pantry/order/plan.ts:213-245 | order.test.ts:149 [R1], :274 [F3] · plan.test.ts:136, :145, :153 [R1] · explain.test.ts:40 [ADR-08] | |
| F3-14 | 확정하면 주기 닫히고 새로 열림, 확정 시트 문구, "주기 마감"은 표시용 글자 | 완료 | S/modules/pantry/order/service.ts:204-249, S/modules/pantry/order/repo.ts:197, P/api/pantry-order.ts:20, W/modules/pantry/MergePanel.tsx:194-298 | order.test.ts:209 [R16] · board.test.ts:464 | |
| F3-15 | 알림은 다음 2주, 이번엔 S6 "내 요청" 상태(주문에 들어감·다음으로 넘어감) | 완료 | S/modules/pantry/service.ts:380-419, W/modules/pantry/MyRequests.tsx:10-70 | board.test.ts:482 [F3-15] | 알림 자체는 9절 R12 줄 |
| F3 완료1 | `/ask`로 판 쓰기 실패(경로·DB 권한 시험), 묻기 카나리 판·DB 0 | 완료 | S/modules/pantry/service.ts:81-86(읽기 전용 트랜잭션), :121-154 | board.test.ts:52 [F3-완료1], :73 [ADR-04 시험] | DB 역할 분리 대신 읽기 전용 트랜잭션이에요. ADR-04가 허용한 대안("안 되면 코드 의존 금지 + 시험")이에요. 역할 분리는 `D/001_base.sql:144`에 "다음에 할 것"으로 남아 있어요 |
| F3 완료2 | 판 글자 = 미리보기에서 확정한 글자 | 완료 | P/api/pantry.ts:60(SHAPE: 서버가 손대지 않고 거부) | board.test.ts:81 [F3-완료2] | |
| F3 완료3 | 투표·거두기·합치기·풀기 무작위 병렬에서 불변식 ①② | 완료 | S/modules/pantry/bundles.ts, D/401_pantry_board.sql:28 | invariants.test.ts:86 [F3-완료3] | |
| F3 완료4 | 상한 넘는 +1 거부, 동시 연타도 상한 안 넘음 | 완료 | S/modules/pantry/service.ts:277-286 | board.test.ts:284 · invariants.test.ts:182 | |
| F3 완료5 | 총무 아닌 역할의 합치기·되돌리기·주문안 확정, 다른 층 투표 거부 | 완료 | S/modules/pantry/routes.ts:27, S/modules/pantry/order/index.ts:25 | board.test.ts:386, :247 · order.test.ts:84 [F3] | |
| F3 완료6 | 예산 초과 0, 예산 ≥ 최소 몫 합·요청 ≥ 최소 몫·정수 계획 "채울 수 있음" 입력에서 못 받은 층 0, 못 채운 층 경고, 근거 숫자 | 완료(10/26) | S/modules/pantry/order/plan.ts(FloorCover·1단계) | plan-compare.test.ts "[R1·ADR-08 시험] … 못 받은 층 0건이에요" 2개(무작위 800개, 하나라도 나오면 실패), "[D8 1단계 보정] 작은 묶음을 먼저 넣으면…" · plan.test.ts "[D8 1단계 보정]" 3개 | D8 1단계 보정으로 해결했어요. 표 합 차이는 기록만 해요 |
| F3 완료7 | 건강 정보 차단 시험 통과, 탐욕법·정수 계획 차이 기록 | 완료 | P/input-check/rules.ts:27 | board.test.ts:121 [F3-3] · plan-compare.test.ts:256, :261 | |

## 4. PRD MCP 읽기 채널(F1·F2 공통)

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| MCP 요구1 | 읽기 도구 둘뿐, 쓰기 도구 없음, LLM 안 부름, 두 도구의 입출력 칸 | 완료 | S/core/tool-registry.ts:21-67, S/modules/mcp/tools.ts:26-98, S/modules/mcp/mcp-route.ts:32 | mcp-route.test.ts:37 [MCP-1], :46 [MCP-2], :57 [MCP-3], :65 [ADR-14 시험], :182 [MCP-1] | |
| MCP 요구2 | 링크엔 제안 토큰만, MCP 경로 DB 쓰기 없음, 토큰 주인 검사 → S2 "Claude에서 가져온 후보예요" + 다시 조회, 링크는 확인 아님, 찼으면 안내+대안, 만료면 다시 찾기, 쓰기 끔이면 그룹웨어 링크 | 완료 | S/modules/mcp/mcp-route.ts:195-208, S/modules/rooms/service.ts:176-221, S/core/plans.ts:162-165, W/modules/mcp/index.tsx:251-296 | mcp-route.test.ts:104, :113, :122 [MCP 요구 2], :192 [MCP-6] · rooms.test.ts:532, :555, :580, :598, :610 [M3] · integration.test.ts:24 [MCP-6] | |
| MCP 요구3 | 우리 서버가 인가 서버(IdP 중개), 보호 자원 메타데이터, `aud` 검사, 등록 기밀 클라이언트만, 동적 등록 끔, 짧은 접근 토큰, 갱신마다 재직 확인, 10분, [끊기]·모든 기기 로그아웃은 승인 폐기 | 완료 | S/modules/mcp/oauth-routes.ts:25-41, S/modules/mcp/auth-service.ts:133-140, :175-237, :264-298 | oauth.test.ts:45, :54 [ADR-15 시험], :68 [MCP-4], :131, :249 [ADR-15 시험], :342, :349, :388 [MCP-4], :438, :447, :465, :474 [MCP-5] | |
| MCP 요구4 | 허용 두 겹(등록 ID·비밀 + 보안팀 승인 목록), 시험 클라이언트 하나, 허용 목록이 비면 실제 데이터로 켜지 않음 | 부분 | S/modules/mcp/policy.ts:11-31, S/modules/mcp/index.ts:17-47, D/500_mcp_clients.sql | oauth.test.ts:107, :502, :512 [MCP 요구 4] · policy.test.ts:12 [ADR-12·15 시험], :19 | 정책 검사는 있어요. 운영자가 보안팀 승인 클라이언트를 등록하는 경로가 없어요(시연 클라이언트를 seed로만 넣음) |
| MCP 요구5 | 동의 시트: IdP 로그인 뒤 S6 위, 앱 이름·읽는 것·못 하는 것·"그 앱의 AI 모델로 보내져요"·끊는 곳, 버튼 둘 같은 무게·기본 선택 없음, 허용 밖 문구 | 다르게 됨 | W/modules/mcp/index.tsx:142-243, W/App.tsx:15-20, :78, S/modules/mcp/routes.ts:17-78 | oauth.test.ts:79, :139, :160 [MCP 요구 5], :89 [MCP-4] | 문구·버튼은 문서대로예요. 다만 S6 위 시트가 아니라 `/oauth/consent` 단독 화면으로 떠요. 기능 차이는 없어서 화면설계를 고치거나 S6 위 Sheet로 감싸면 돼요(작음) |
| MCP 요구6 | S6 "연결된 AI 앱": 앱 이름·연결한 날·[끊기](확인 시트), "마지막 사용" 없음, 끊기 시트 문구 | 완료 | W/modules/mcp/index.tsx:42-126, S/modules/mcp/routes.ts:80-115 | connections.test.ts:27, :40 [MCP 요구 6], :58 [ADR-03 시험] | |
| MCP 요구7 | 감사 로그는 가명 ID·시각·도구·결과·클라이언트 ID만, 횟수는 가명 ID × 도구, MCP 전체 스위치, 모듈 링크만·끔이면 도구 빠짐, 둘 다 빠지면 "지금 연결할 수 있는 도구가 없어요" | 완료 | S/modules/mcp/mcp-route.ts:48-49, :99, S/core/tool-registry.ts:64-67, S/modules/mcp/policy.ts:35-48 | mcp-route.test.ts:208, :220, :228 [MCP-7], :253 [ADR-13 시험] · oauth.test.ts:172 [MCP-7] · connections.test.ts:47 [MCP-7] · core.test.ts:48 [M5] | |
| MCP 완료1 | 도구 목록에 쓰기 도구 0, MCP 호출 중 게이트웨이 LLM 0 | 완료 | 위 | mcp-route.test.ts:37, :182 | |
| MCP 완료2 | 예약자·제목 넣은 장부로도 `rooms_find_free` 응답에 0, 스키마에 칸·방별 일정 없음 | 완료 | S/modules/mcp/tools.ts:66-89 | mcp-route.test.ts:46, :81 [MCP-2] | |
| MCP 완료3 | 본문 카나리 공지로도 `notices_search` 본문 0, 허용 밖 게시판 0 | 완료 | S/modules/mcp/tools.ts:92-98, :162-171 | mcp-route.test.ts:57, :152 · notices.test.ts:106, :120 | |
| MCP 완료4 | 토큰 없음·`aud` 다름·미등록·동적 등록·만료 거부 | 완료 | S/modules/mcp/auth-service.ts:264-280 | oauth.test.ts:342, :349, :269, :68, :388 | |
| MCP 완료5 | 모의 IdP에서 계정 끄면 10분 안 MCP 호출·갱신 거부(걸린 시간 기록), [끊기]·모든 기기 로그아웃 뒤 갱신 거부 | 완료 | S/modules/mcp/auth-service.ts:281-298, S/core/guard.ts:73-77 | oauth.test.ts:438, :447, :455, :465, :474 [MCP-5] | |
| MCP 완료6 | 링크만 열어 생긴 예약 0, 남의 링크 열림 0, MCP 경로 DB 쓰기 0(감사 로그 빼고), 감사 로그 검색어·조건 카나리 0 | 완료 | 위 | integration.test.ts:24 · mcp-route.test.ts:192, :208 · rooms.test.ts:532, :555 | |
| MCP 완료7 | rooms·notices 링크만·끔 → 도구 빠짐, MCP 끄면 연결 거부 | 완료 | 위 | mcp-route.test.ts:220, :228 | |
| MCP 완료8 | 시연 시나리오(모의): 동의 → 조회 → 링크 → 앱 예약, 끊기, 퇴사 차단 | 완료 | 위 | connections.test.ts:77 [MCP-8] · oauth.test.ts:188 [MCP 시연] | claude.ai 실제 연결은 14절 9일 차(외부) 줄 |

## 5. PRD 비기능·보안 요구사항

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| 비기능 원문 비보관 | 로거·오류 보고에 본문 칸 없음, 분석·녹화 도구 안 씀, URL·브라우저 저장소에 원문 없음, 자동 완성 끔, 모듈 사이 대화 기억 없음 | 완료 | S/app.ts:74-84, W/api.ts:44-53, W/components/CheckedInput.tsx:47, S/core/ai/gateway.ts:61-73 | conventions.test.ts:41, :48 [R13] · app.test.ts:54 | 프록시·APM 본문 기록 끄기는 배포 설정 몫이에요. 로그 카나리 시험은 없어요(→ 7절 첫 줄) |
| 비기능 공통 입력 검사 | 묻기·요청 쓰기 칸 모두 브라우저·서버 양쪽, 가림 줄은 입력 칸 바로 아래 | 완료 | W/components/CheckedInput.tsx:22-61, S/routes/ask.ts:28, S/modules/pantry/routes.ts:43 | check.test.ts · app.test.ts:42 | |
| 비기능 묻기·게시 분리 | `/ask`는 저장·게시 못 함, 가능하면 DB 역할도 나눔, 게시는 품목 이름만 공개 미리보기로 | 완료 | S/modules/pantry/service.ts:81-86 | board.test.ts:52, :73 | DB 역할 분리는 아직 없어요(F3 완료1 메모) |
| 비기능 쓰기 경계 | LLM 쓰기 도구 없음, 쓰기 카드엔 제안 토큰만, 확인은 쓰기마다 한 번, 고정 버튼은 같은 실행 함수(권한·상태 재검사·멱등 키), 확인 시트 목록, 누르면 잠김 | 완료 | S/core/fixed-action.ts:23-69, S/core/plans.ts, W/components/ActionHost.tsx:54-97, :140-167 | plans.test.ts 전체 · connections.test.ts:58 · board.test.ts:96 | 모든 기기 로그아웃은 실행기(FixedActions)를 거치지 않고 경로에서 바로 해요(세션이 메모리라 영향 작음). +1·거두기·따로 두기는 멱등 키 없이 "이미 있으면 그대로"로 멱등해요 |
| 비기능 역할 표 | 직원·총무·분장표 주인·운영자 할 수 있는 것/못 하는 것 | 부분 | S/core/roles.ts:5-10, S/routes/config.ts:35-75 | app.test.ts:83 [R7] · board.test.ts:386 · navi.test.ts:403 · order.test.ts:84 | 운영자 몫 중 감사 로그(최근 20줄)·AI 비용·스위치는 있어요. 10명 이상 묶음 통계, 오류 표, 설정값(회의 길이·횟수 상한) 바꾸기, MCP 클라이언트 등록이 없어요 |
| 비기능 권한 계산 | 요청마다 (역할, 층, 모듈, 동작), 세션엔 누구인지만, 총무·운영자는 IdP 그룹(없으면 운영자가 관리하는 역할 표), 분장표 주인은 부서 클레임 | 부분 | S/core/guard.ts:57-69, S/core/roles.ts:5-10, S/modules/navi/service.ts:188-192 | app.test.ts:27 [ADR-13] · navi.test.ts:369 [R17] | "IdP 그룹이 없을 때 운영자가 관리하는 역할 표"가 없어요 |
| 비기능 감사 로그 | 묻기는 가명 ID·시각·모듈 종류·결과(카드 만듦/못 찾음/잠김)만, 쓰기는 모듈·동작·결과, MCP는 도구·결과·클라이언트 | 완료 | S/core/audit.ts:4-38, S/core/router.ts:65, :73, :78, :84 | core.test.ts:72 [R11] · router.test.ts:87 [R11] | 묻기 결과 값에 `reask`(되묻기)·`link`(링크 카드)가 더 있어요. 내용이 없어 원칙은 지켜요. PRD 목록에 두 값을 더해 두길 권해요 |
| 비기능 세션·퇴사 | 서버 세션(httpOnly), 토큰 브라우저에 없음, 퇴사 10분 안 웹·MCP 끊김, 세션 8시간, 모든 기기 로그아웃이 MCP 승인도 폐기, 모의 OIDC | 완료 | S/core/session.ts:4-61, S/core/guard.ts:20-44, :73-77, S/routes/auth.ts:25-38, :63-74 | app.test.ts:27, :35, :66, :75 · oauth.test.ts:455, :474 | |
| 비기능 접속 관문과 MCP | 관문에서 `/mcp`·인가 경로만 Anthropic 대역에 열기(보안팀 승인) | 없음(코드 밖) | — | — | 보안팀 승인 대기(PRD 열린 질문) |
| 비기능 AI 게이트웨이 | 하나로만, 무보관 모델 고정, 등급 0·1만(계약 전 0만), 무상태, 파일 API 등 안 씀, 스키마에 사내 정보 없음 | 다르게 됨 | S/core/ai/gateway.ts:56-73, P/grades.ts:11-14, S/modules/pantry/similarity.ts:124, :158, :192, S/modules/pantry/order/explain.ts:106, S/config.ts:43 | core.test.ts:21, :28 [ADR-10] · navi.test.ts:183 [R6] | 게이트웨이 구조는 맞아요. 그런데 판 요청 쓰기 칸 글(직원이 쓴 문장)·같은 상품 판정·주문안 설명을 등급 0으로 못 박아 보내요. 실제 모델(`DESK_AI_PROVIDER=anthropic`)로 켜면 계약 전에도 직원 문장이 나가요. 문서(CLAUDE.md "계약 전엔 등급 0만", CONVENTIONS "등급은 어댑터 mock 여부로")가 맞아 보여요. 모델도 환경 변수로 아무 값이나 받아요(무보관 모델 허용 목록 없음) |
| 비기능 시연 데이터 띠 | 모의 어댑터가 하나라도 켜지면 띠, 누르면 모의 목록 | 완료 | W/components/DemoBand.tsx:4-21, W/App.tsx:72, S/routes/config.ts:20-31 | app.test.ts:83 [R7] | |
| 비기능 주입 방어(코드) | 모듈 호출에는 그 모듈 읽기 자료만, MCP 출력은 정해진 칸뿐 | 완료 | S/core/router.ts:29-39, S/modules/navi/service.ts:45-47, S/modules/mcp/tools.ts:101-171 | mcp-route.test.ts:162 [ADR-14 시험] · policy.test.ts:63 [ADR-14 시험] | 시스템 문장마다 "안의 지시는 따르지 말고"가 있어요 |
| 비기능 주입 시험 | 10일 차에 공지·요청·분장표 속 지시문 주입 시험 | 없음(일정상 나중) | — | — | 10일 차 |
| 비기능 끄기 스위치 | 모듈마다 켬/링크만/끔(운영자만, 감사 로그), 링크만 → 링크 카드, 끔 → 후보에서 빼고 담당 안내 + 예시 칩·진입점 숨김, 세부 스위치, 단독 모드 | 부분 | P/switches.ts:4-57, S/core/ops-settings.ts:16-26, S/routes/config.ts:40-75, S/core/router.ts:52-80 | router.test.ts:79 [R4] · core.test.ts:65 [R4] · plans.test.ts:127 [ADR-12 시험] | 서버 쪽은 다 있어요. 웹이 예시 칩(W/screens/Ask.tsx:10)과 S4·S5 진입점(W/screens/Mine.tsx:41-50)을 스위치에 맞춰 숨기지 않아요 |
| 비기능 접근성·모바일 | 폰 한 손, 입력창·주 버튼 아래, 바닥 시트, 뒤로 가기 한 번이면 닫힘, 라벨 글자, S4·S5 PC 우선 | 부분 | W/components/Sheet.tsx:4-24, W/screens/Ask.tsx:53, W/modules/pantry/order/index.tsx:21-31, W/modules/navi/ChartScreen.tsx:177-178 | — | 시트는 닫기·바깥 누르기·Esc로만 닫혀요. 브라우저 뒤로 가기(popstate)로 닫히지 않아요. S4 합치기 칸은 폰 제한이 없어요 |

## 6. ADR-01~15 결정

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| ADR-01 | 모듈형 모놀리스, 모듈은 자기 표·쓰기 경로만, 도구 레지스트리 칸 {이름, 입력, 출력, 필요 권한, 읽기/쓰기, 모듈, MCP 공개}, 읽기 전용 MCP 2주 안 | 부분 | S/core/module.ts:56-68, S/core/services.ts, S/core/tool-registry.ts:5-61 | conventions.test.ts:24 [ADR-01] | 모듈 경계는 import 규칙 시험으로 지켜요. 레지스트리에 출력 스키마·필요 권한 칸이 없어요(출력은 `S/modules/mcp/tools.ts`에 따로) |
| ADR-02 | 규칙 + LLM 한 번, 확신 두 단계, 낮으면 칩 + "다른 거예요", 숫자 확률 안 넘김, unknown → 담당 안내, 끔은 후보에서 빠짐 | 완료 | S/core/router.ts:50-86, P/switches.ts:55-57 | router.test.ts:44-87 | |
| ADR-03 | LLM은 제안만, 제안 토큰(서명·짧은 수명), 확인은 쓰기마다 한 번, plan 칸·상태 전이·조건부 갱신, 실행 재검사, 만료 → 다시 찾기, 막힘 이유 코드, 라벨 대응 | 완료 | S/core/plans.ts, S/core/proposal-token.ts:19-56, S/core/fixed-action.ts, D/001_base.sql:22-32 | plans.test.ts:88-151 · slots-token.test.ts:33 | `제안됨 → 취소` 전이는 쓰는 길이 없어요(시트를 닫으면 만료로 끝남). 막힘 이유 코드는 문구로만 나가요(작음) |
| ADR-04 | `/ask`·`/pantry/draft` 저장 없음·판 쓰기 권한 없음, 초안엔 원문 없음, 공개 미리보기 = 확인, [올리기]는 토큰+이름만, 서버 재검사 후 카드+작성자 표 한 트랜잭션, 멱등 키 = 토큰 ID, 만료면 고친 이름으로 새 토큰 | 완료 | S/modules/pantry/service.ts:40-53, :81-86, :182-266, S/core/plans.ts:98-142, D/401_pantry_board.sql:8-9 | board.test.ts:52, :73, :81, :96, :113, :211 [ADR-03 시험] | DB 역할 분리 대신 읽기 전용 트랜잭션(F3 완료1) |
| ADR-05 | 어댑터 + capabilities(모의, 빈 시간, 쓰기), 띠, 역할 받는 곳(R17), 2주 출처: 회의실 모의 장부, 분장표·공지·카탈로그 파일 가져오기, 분장표 가져오기는 이름 칸 버림 | 부분 | S/adapters/types.ts, S/modules/rooms/ledger-adapter.ts:6-48, S/modules/navi/chart-csv.ts | rooms.test.ts:479 [ADR-05] · chart-csv.test.ts:16 [D9] | 분장표는 CSV로 가져와요. 공지·카탈로그는 코드 안 고정 자료(seed)뿐이고 파일 가져오기 경로가 없어요. IdP 그룹 없을 때의 역할 표도 없어요 |
| ADR-06 | 모의 장부가 원본, 범위 + 겹침 제약(btree_gist), 취소는 이력 표로, 확정 = 재확인, 빈 방 없음은 안내, 대안 순서, 화면 타입에 예약자 칸 없음 | 완료 | D/001_base.sql:4, :43-62, D/300_rooms_ledger.sql, S/modules/rooms/search.ts:139, S/modules/rooms/service.ts:226-305 | rooms.test.ts:283, :313, :387, :441, :471 · search.test.ts:38 | |
| ADR-07 | 표는 원 카드, 묶음 = 되돌리지 않은 합치기, 대표 고르기, 총무만 확정, 같은 상품 표시 계산(R15), 셈, 상한(R14), 주기(R16), 동시성(R3), 불변식 I1~I8 | 완료 | S/modules/pantry/bundles.ts, S/modules/pantry/service.ts:63-67, :270-598, D/401_pantry_board.sql | invariants.test.ts:86-253 · board.test.ts:347, :374 [ADR-07 I6] · bundles.test.ts | |
| ADR-08 | 층 목표, 꼭 채울 층(최소 비용), 1단계(정확한 채움 확인)·2단계, 경고·잠금, 묶음 단위 경고, 고친 줄 재검사·틀 문장, 설명은 정해진 칸만, 숫자 검사, 정수 계획은 시험에서만 | 완료 | S/modules/pantry/order/plan.ts, S/modules/pantry/order/explain.ts | plan.test.ts · explain.test.ts · order.test.ts · plan-compare.test.ts | 10/26 개정(D8 1단계 보정) |
| ADR-08 다시 볼 조건 | 정수 계획은 채우는데 주문안이 못 채운 입력이 시험에서 나오면 D8을 다시 정함 | 완료(10/26) | S/modules/pantry/order/plan.ts | plan-compare.test.ts "[D8 1단계 보정] 작은 묶음을 먼저 넣으면…" | 조건이 성립해 사용자가 D8을 1단계 보정으로 바꿨어요. 새 다시 볼 조건은 ADR-08에 있어요 |
| ADR-09 | 분장표 행 칸(사람 이름 없음), LLM은 후보 중 하나/없음, 다른 후보 최대 3, 공지 요약 꺼 둠, 관련 공지 링크 없음, "틀렸어요" 여섯 칸, S5 목록만 | 완료 | D/001_base.sql:111-132, S/modules/navi/cards.ts:26-52, S/modules/notices/service.ts:37-65 | navi.test.ts:210-258, :261, :282 | |
| ADR-10 | 게이트웨이 하나, 등급 2 이상 거부, 계약 전 등급 0만, 무상태, 모듈 허용 자료만, 샐 틈 막기, 감사 로그 칸, 운영자도 투표·승인 토큰 해시 직접 못 읽음(읽기 역할 분리), 운영 표(감사 로그·10명 묶음 통계·오류·AI 비용) | 부분 | S/core/ai/gateway.ts, S/core/audit.ts, S/routes/config.ts:35-38, D/001_base.sql:144-145 | core.test.ts:21, :28 · app.test.ts:54 | 등급 0 고정 호출(5절 AI 게이트웨이), DB 읽기 역할 분리 없음, 10명 묶음 통계·오류 표 없음 |
| ADR-11 | 묻기·요청 칸 둘 다, 잠금(주민번호·비밀번호·키·토큰·건강), 가림(이메일·IP) + 가림 줄, 자동 완성 끔, 규칙 파일 하나(버전), 서버 재검사 후 "차단"만 감사, 제도 이름(병가)은 사전에서 뺌 | 완료 | P/input-check/rules.ts, P/input-check/check.ts, S/routes/ask.ts:28-32, S/modules/pantry/routes.ts:43-47 | check.test.ts:5-39 · app.test.ts:42 | 감사 결과 값은 `locked`예요. 자동 완성 꺼짐 시험은 없어요 |
| ADR-12 | 켬·링크만·끔, 세부 스위치(회의실 쓰기·공지 요약·S5), MCP 전체, 단독 모드, 레지스트리가 꺼진 도구 뺌, 실행기가 꺼진 plan 막힘, 설정값(회의 길이·만료·횟수·재확인)은 운영자만 바꾸고 감사 로그 | 부분 | P/switches.ts, S/core/ops-settings.ts, S/routes/config.ts:40-75, S/core/plans.ts:167-178 | core.test.ts:60, :65 · plans.test.ts:127 · router.test.ts:79 | 설정값을 바꾸는 운영자 경로가 없고(`patchValues`는 감사 로그 없음), 운영 설정이 서버 메모리라 다시 켜면 처음으로 돌아가요. 웹 예시 칩·진입점 숨김 없음 |
| ADR-13 | 서버 세션·httpOnly·SameSite·CSRF, 8시간, 재직 재확인(10분보다 짧게), 백채널 로그아웃, 모든 기기 로그아웃 = 세션 + MCP 승인, 역할은 요청마다, 가명 ID × 동작 카운터(429) | 완료 | S/core/session.ts, S/core/guard.ts:20-44, S/core/rate-limit.ts:2-23, P/switches.ts:44 | app.test.ts:27, :35, :66, :75 · mcp-route.test.ts:253 · board.test.ts:227 · navi.test.ts:357 | 백채널 로그아웃은 없어요(ADR도 "확인 필요"라 사내 IdP가 정해진 뒤 일). 쿠키 Secure는 운영 환경에서만 켜요 |
| ADR-14 | 두 도구 입출력, LLM·DB 쓰기 없음, 입력 길이·목록 검증, 나가는 제목 정리, 앱 확인 링크(서명 토큰), 주인 검사, 링크는 확인 아님, 만료 → 조건만 꺼내 다시 찾기 | 완료 | S/modules/mcp/tools.ts, S/modules/mcp/mcp-route.ts, S/modules/rooms/service.ts:184-221 | mcp-route.test.ts:65, :130, :162, :173, :262 [ADR-14 시험] · rooms.test.ts:531-618 | 공지 최대 개수가 운영 설정이 아니라 상수(5)예요(작음) |
| ADR-15 | `/mcp` 자원 서버·우리 인가 서버, 401 + resource_metadata, RFC 9728·8414 메타데이터, S256만, 동적 등록·CIMD 없음, 기밀 클라이언트·정확한 리디렉트, resource 필수, 갱신 회전·재직 확인, 승인 표, 동의 시트, 허용 두 겹, 네트워크 대역 | 완료 | S/modules/mcp/oauth-routes.ts, S/modules/mcp/auth-service.ts, D/500_mcp_clients.sql | oauth.test.ts 전체(:45~:512) · policy.test.ts:46, :56 | 네트워크 대역 개방은 코드 밖(5절). 클라이언트 등록 경로 없음(4절 MCP 요구4) |

## 7. ADR "시험으로 지키는 것" 표

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| 시험 10·11 | 질문 원문 저장 0건: DB 덤프·앱 로그·오류 보고·프록시·APM·URL·브라우저 저장소, 자동 완성 꺼짐 | 부분 | — | app.test.ts:54 · conventions.test.ts:48 · navi.test.ts:192 · board.test.ts:52 | DB·브라우저 저장소만 있어요. 로그·오류 응답·URL·자동 완성 시험이 없어요 |
| 시험 10 | 묻기 감사 로그 칸(행 ID·공지 ID·슬롯 없음) | 완료 | S/core/audit.ts | router.test.ts:87 [R11] · navi.test.ts:173 · core.test.ts:72 | |
| 시험 10 | 알림 주소 표 | 없음(일정상 나중) | — | — | 다음 2주(M6) |
| 시험 11 | 브라우저·서버 검사 일치 | 완료 | P/input-check/check.ts | check.test.ts · app.test.ts:42 | 두 쪽이 같은 함수를 import해서 다를 수 없어요. 규칙별 예시 표로 비교하는 시험은 따로 없어요 |
| 시험 02 | 라우팅 경계 골든셋 측정 | 없음(일정상 나중) | S/core/router-rules.ts | router.test.ts:62 [ADR-02 시험](한 문장) | 10일 차 |
| 시험 03 | plan 한 번만 실행, 만료·남의·꺼진 모듈 거부, 모든 예약 행 plan 확인(DB 검사) | 완료 | S/core/plans.ts | plans.test.ts:100, :108, :127 · rooms.test.ts:251, :368 | |
| 시험 03 | 만료 뒤 다시 찾기 | 완료 | S/core/plans.ts:188-202 | plans.test.ts:118 · rooms.test.ts:598 | |
| 시험 03·04 | 게시 확인 한 번([올리지 않기] DB 변화 0, [올리기] 카드+표 1, 같은 토큰 두 번 → 카드 1, 글자 같음) | 완료 | S/core/plans.ts:98-142 | board.test.ts:81, :96, :113 · plans.test.ts:142 | |
| 시험 04 | `/ask`·`/pantry/draft` 역할로 판 INSERT 실패 | 완료 | S/modules/pantry/service.ts:81-86 | board.test.ts:52, :73 | 역할 대신 읽기 전용 트랜잭션 |
| 시험 06 | 동시 확정 성공 1·막힘 + 대안 2, 처음부터 빈 방 없음 → 안내 | 완료 | D/001_base.sql:50 | rooms.test.ts:313, :154 | |
| 시험 06 | 예약자 비노출(화면 타입·응답 스키마) | 완료 | S/modules/rooms/ledger-adapter.ts:23 | rooms.test.ts:471, :621 · mcp-route.test.ts:46 | |
| 시험 07 | 불변식 I1~I8 무작위 병렬, 모두 되돌리면 다시 센 값, 같은 사람 동시 +1, +1과 합치기 동시 409 없음, 두 총무 409 하나 | 완료 | S/modules/pantry | invariants.test.ts:86, :182, :201, :217, :253 · board.test.ts:374 · order.test.ts:258 [I6] | |
| 시험 08 | 주문안 규칙(R1): 예산 초과 0, "채울 수 있음" 입력에서 못 받은 층 0, 경고, 잠금, 고친 줄, 근거 숫자, highs-js 차이 기록 | 다르게 됨 | S/modules/pantry/order/plan.ts | plan.test.ts · plan-compare.test.ts:183, :229, :256, :261 · explain.test.ts | "못 받은 층 0"에 반례가 있어요(F3 완료6) |
| 시험 09 | 근거: 없는 질문을 섞어 근거 없는 카드 0 | 완료 | S/modules/navi/service.ts:203-211 | navi.test.ts:117 [F1 완료 기준] | 가상 자료 단위 시험이에요. 10일 차 실제 측정은 F1 완료7. 공지 요약 인용 시험은 요약이 꺼져 있어 해당 없어요 |
| 시험 09 | 사람 이름·기록 칸(이름 0, 여섯 칸, 자유 문장 거부, 주인 저장 전 변화 0) | 완료 | S/modules/navi | navi.test.ts:509, :261, :282, :339 | |
| 시험 05·13 | 역할 × 동작(직원 합치기·주문안·분장표 올리기, 다른 부서 행, 다른 층 투표 거부) | 완료 | 위 | board.test.ts:386, :247 · order.test.ts:84 · navi.test.ts:403, :414 | |
| 시험 01·10 | 모듈 허용 목록: 모듈별 LLM 입력에 다른 모듈 자료·도구 없음(레지스트리 스냅샷) | 부분 | S/core/tool-registry.ts:69-73 | core.test.ts:60 [ADR-10] · navi.test.ts:223 · explain.test.ts:94 | `toolsForModule`은 시험에서만 불러요. 모듈별 LLM 입력 스냅샷 시험이 없어요 |
| 시험 12 | 끄기 스위치: 링크만 → 링크 카드, 끔 → 후보 빠짐·담당 안내·예시 칩 숨김, plan 막힘, 단독 모드 첫 화면 | 부분 | 위 | router.test.ts:79 · plans.test.ts:127 · rooms.test.ts:490, :509 · board.test.ts:195, :227 | 예시 칩 숨김은 코드도 없고, 단독 모드 첫 화면(코드는 있음, W/App.tsx:66)은 웹 시험이 없어요 |
| 시험 13 | 퇴사·세션(재확인 간격 뒤 첫 요청 거부, 모든 기기 로그아웃) | 완료 | S/core/guard.ts | app.test.ts:66, :75 | |
| 시험 13 | 요청 횟수: 묻기·게시·+1·MCP 도구별 429, 카운터에 내용 없음 | 부분 | S/core/rate-limit.ts | board.test.ts:227 · mcp-route.test.ts:253 · navi.test.ts:357 | 묻기(`/api/ask`) 429 시험이 없어요 |
| 시험 15 | MCP 인가(401 + resource_metadata, aud·만료·폐기, 미등록·동적 등록·PKCE 없음, 범위 부족 403) | 완료 | S/modules/mcp | oauth.test.ts:68, :121, :131, :342, :349, :388 · mcp-route.test.ts:242 | |
| 시험 15·13 | MCP 폐기·퇴사 | 완료 | S/modules/mcp/auth-service.ts:281-298 | oauth.test.ts:438-492 | |
| 시험 14·10 | MCP 출력·경로(칸 없음, 쓰기 도구 0, 게이트웨이 0, DB 쓰기 0, 감사 행 검색어 없음) | 완료 | S/modules/mcp | mcp-route.test.ts:37-57, :182-208 | |
| 시험 14 | 앱 확인 링크(열기만 하면 DB 변화 0, 남의 링크, 만료 다시 찾기, 확인 시트에서만 예약) | 완료 | S/modules/rooms/service.ts:184-221 | integration.test.ts:24 · rooms.test.ts:532-610, :650 | |
| 시험 12·14·15 | MCP 스위치·계약 전 잠금 | 완료 | S/modules/mcp/policy.ts, S/routes/config.ts:56-75 | policy.test.ts:12, :34 · mcp-route.test.ts:220, :228 · oauth.test.ts:172, :502 | |
| 시험 03·09 | 주입(지시문 → 쓰기 0, 다른 모듈 호출 0) | 없음(일정상 나중) | — | — | 10일 차 |
| 시험 10 | 감사 로그 형식(내용 칸 없음, 10명 미만 묶음 통계 안 보임) | 부분 | S/core/audit.ts | core.test.ts:72 [R11] | 묶음 통계 자체가 없어요 |

## 8. 결정 D1~D13

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| D1 | 합쳐요, 모듈마다 끄기 스위치, 판정 규칙(그룹웨어 AI·실제 연결·운영 주인) | 완료 | P/switches.ts, S/routes/config.ts:40-75 | router.test.ts:79 · core.test.ts:65 | 판정 자체는 운영 판단이에요. 웹 숨김 쪽은 7절 시험 12 |
| D2 | 핵심 기능 셋(F1·F2·F3) | 완료 | S/modules/navi·notices·rooms·pantry | 1~3절 | |
| D3 | IT 캡처·FAQ·티켓 빼고 모든 입력에 공통 검사 | 완료 | P/input-check | check.test.ts | |
| D4 | 아래 탭 셋, 입력창은 묻기 탭에만, 공통 검사 → 규칙 → LLM 한 번, 되묻기, 모름 → 담당, 홈 "새 공지" 카드 없음 | 완료 | W/components/TabBar.tsx, W/screens/Ask.tsx, S/core/router.ts | router.test.ts | |
| D5 | LLM 제안만, plan 저장, 확인 버튼은 plan_id만, 실행 재검사, 멱등 | 완료 | S/core/plans.ts | plans.test.ts | |
| D6 | 모의 장부 쓰기, 파일럿은 실제 연결 전까지 쓰기 끔, 하루 단일, 이름 어댑터에서 버림, DB 겹침 | 완료 | S/modules/rooms, P/switches.ts:29 | rooms.test.ts | 회의실 쓰기 기본값은 켬(시연)이에요. 파일럿 때 운영자가 꺼야 해요 |
| D7 | 묻기 경로 저장·게시 못 함, 확인한 품목 이름만, 게시 직전 재검사 | 완료 | S/modules/pantry/service.ts:81-86, :182-256 | board.test.ts:52, :81, :121 | |
| D8 | 표 = 서로 다른 사람 수, 합치기는 표를 안 옮김, 총무만 확정, 탐욕법 + 이유 코드(10/26 1단계 보정), 정수 계획은 시험 비교용 | 완료 | S/modules/pantry | invariants.test.ts · plan-compare.test.ts | 10/26 1단계 보정 반영 |
| D9 | 행 ID만 고르고 원문을 그림, 없으면 "여기로 물어보세요", 사람 이름·질문 원문 없음 | 완료 | S/modules/navi | navi.test.ts:53, :98, :509 | |
| D10 | 공지는 물을 때만, 이번엔 제목·게시일·원문 링크만(M6) | 완료 | S/modules/notices | notices.test.ts:32 | |
| D11 | 모듈형 모놀리스, 읽기 전용 MCP(M1로 바뀜), 모의 장부·파일·모의 OIDC | 완료 | S/app.ts, S/modules/mcp, S/adapters/mock/employees.ts | 4절 | |
| D12 | 이름 가안 "한 줄 데스크", 입력창 문구 | 완료 | W/screens/Ask.tsx:39, :56, W/screens/Login.tsx | — | 최종 이름은 사용자 몫(PRD 사용자 확인 4) |
| D13 | 자르는 순서 ①공지 요약 ②S5 단순화(처음부터 적용) ③회의실 쓰기(9일 차 조건부) | 완료 | P/switches.ts:13-14, :31-32 | — | ③은 적용 조건이 아직 아니에요 |

## 9. 결정 R1~R18

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| R1 | 다른 층 몫 남기고 담기, 예산 < 최소 몫 합이면 만들되 잠금, 요청 모자란 층 경고만 | 완료 | S/modules/pantry/order/plan.ts:112-245 | plan.test.ts:37-153 [R1] · order.test.ts:103, :149, :192 [R1] | 반례는 F3 완료6 |
| R2 | `/ask` 저장 없음, 제안 토큰만, 확인은 쓰기마다 한 번 | 완료 | S/core/plans.ts, S/core/fixed-action.ts | plans.test.ts:142, :151 [R2] | |
| R3 | 표 누를 땐 버전 안 오름, 409는 다른 총무가 먼저 바꿨을 때만 | 완료 | S/modules/pantry/service.ts:287, :510-576 | invariants.test.ts:217 [R3·I8] · order.test.ts:298 [R3] | |
| R4 | 켬/링크만/끔 + 세부 스위치, 단독 모드, 운영자만 | 부분 | P/switches.ts, S/routes/config.ts:40-75 | router.test.ts:79 [R4] · core.test.ts:65 [R4] | 웹 예시 칩·진입점 숨김 없음(5절 끄기 스위치) |
| R5 | 막힘은 확인 순간만, 처음부터 없으면 안내 + 대안 2 | 완료 | S/modules/rooms/cards.ts:58-94 | rooms.test.ts:154, :313 · rooms.test.ts:580 [M3·R5] | |
| R6 | 모의 어댑터면 띠 하나, 계약 전 실제 직원 파일럿 금지 | 완료 | W/components/DemoBand.tsx, S/core/ai/gateway.ts:61-62, S/config.ts | app.test.ts:83 · navi.test.ts:183 [R6] | 등급 0 고정 호출은 5절 AI 게이트웨이 |
| R7 | 역할·종류·카드 라벨 용어 | 완료 | P/kinds.ts, P/cards.ts:4-5, W/labels.ts | app.test.ts:83 [R7] | |
| R8 | "틀렸어요" 넷, 기록 여섯 칸, 사용자 ID 없음 | 완료 | S/modules/navi/service.ts:225-246 | navi.test.ts:260-309 [F1-8·R8] | 시각을 날 단위로 줄여요(F1-8 메모) |
| R9 | 기록이 분장표를 자동으로 안 바꿈, 주인이 직접 고쳐야 반영 | 완료 | S/modules/navi/service.ts:295-318 | navi.test.ts:339, :447 [R9] | |
| R10 | 담당 카드에서 관련 공지 링크 뺌 | 완료 | S/modules/navi/cards.ts:26-52 | — | |
| R11 | 묻기 감사 로그는 가명 ID·시각·모듈 종류·결과만 | 완료 | S/core/router.ts, S/core/audit.ts | router.test.ts:87 · core.test.ts:72 [R11] | |
| R12 | 알림(같이 채워요만, 알림 주소 표, 링크엔 카드 ID) — M6로 다음 2주 | 없음(일정상 나중) | — | — | S6 상태로 대신해요(F3-15) |
| R13 | 오류 보고·APM 본문 끔, URL·브라우저 저장소 금지, 자동 완성 끔 | 완료 | W/components/CheckedInput.tsx:47, W/api.ts:44-53, S/app.ts:74-84 | conventions.test.ts:48 [R13] | 시험 빈칸은 7절 시험 10·11 |
| R14 | 표 상한 = 열린 묶음 중 내 표 묶음 수, +1(·게시) 순간만 검사 | 완료 | S/modules/pantry/service.ts:228-229, :285-286 | board.test.ts:284, :313 [R14] | |
| R15 | 게시 순간 AI가 열린 품목과 비교해 판 표시 + 총무 제안함 | 완료 | S/modules/pantry/service.ts:139, :247-254, :477-507 | board.test.ts:405 · similarity.test.ts | AI 판정은 초안 때(F3-6 메모) |
| R16 | 확정 때 주기 닫고 새로 열고 나머지 넘김 | 완료 | S/modules/pantry/order/service.ts:204-249 | order.test.ts:209 [R16] | |
| R17 | 총무·운영자는 IdP 그룹, 분장표 주인은 부서 클레임, 서버가 요청마다 | 완료 | S/core/roles.ts:5-10, S/core/guard.ts:57-69 | navi.test.ts:369 [R17] · app.test.ts:27 | "역할 표" 대안은 5절 권한 계산 |
| R18 | 일정 조정(모든 기기 로그아웃·S6·주기 닫기 배치, 무보관 계약 지연 위험) | 완료 | — | — | 문서 결정이에요(기획서 2주 일정에 반영) |

## 10. 결정 M1~M7

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| M1 | F4 없이 "MCP 읽기 채널" 절, 도구 둘, 우리 쪽 LLM 없음 | 완료 | S/core/tool-registry.ts:21-61 | mcp-route.test.ts:37, :182 | |
| M2 | 우리 서버가 인가 서버, IdP 중개, 기밀 클라이언트만, 동적 등록 끔, 갱신 때 재직, 시험 클라이언트 하나, 계약 전 모의 데이터만 | 완료 | S/modules/mcp | oauth.test.ts · policy.test.ts | 운영자 등록 경로는 4절 MCP 요구4 |
| M3 | 링크엔 서명 토큰만, 남의 링크 안 열림, 링크는 확인 아님 | 완료 | S/core/proposal-token.ts, S/modules/rooms/service.ts:184-221 | rooms.test.ts:531-618 [M3] · slots-token.test.ts:25 | |
| M4 | 새 화면 번호 없이 S6 위 동의 시트, S6 "연결된 AI 앱", "마지막 사용" 없음 | 다르게 됨 | W/modules/mcp/index.tsx:42-243 | connections.test.ts:27 | 동의 시트가 단독 화면으로 떠요(4절 MCP 요구5) |
| M5 | MCP 감사 로그 칸, 검색어 없음, MCP 전체 스위치, 모듈 꺼지면 도구 빠짐 | 완료 | S/modules/mcp/mcp-route.ts:48, S/core/tool-registry.ts:64 | core.test.ts:48 [M5] · mcp-route.test.ts:208, :228 | |
| M6 | 공지 요약·S5 행 고치기 빼기, 알림 모의 미룸, 판 새로고침 | 완료 | P/switches.ts:13-14, W/modules/pantry/BoardScreen.tsx:14 | — | |
| M7 | 사용자 확인 1번 답, 무보관 질문 넓힘, 보안팀 질문 둘 | 완료 | — | — | 문서 결정이에요 |

## 11. 화면 S1~S6, 카드, 시트

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| 공통 띠 | 모든 화면 위 "시연 데이터로 돌아가요", 누르면 모의 목록(동의 시트 포함) | 완료 | W/App.tsx:72, W/components/DemoBand.tsx | app.test.ts:83 | |
| 아래 탭 | 묻기/같이 채워요/내 것, 단독 모드면 묻기 숨김·S3 첫 화면 | 완료 | W/components/TabBar.tsx:3-25, W/App.tsx:66, :95 | — | |
| 스위치 화면: 링크만 | S2 링크 카드 | 완료 | S/core/router.ts:77-80 | router.test.ts:79 | |
| 스위치 화면: 끔 | 라우터 후보에서 빠짐·담당 안내, 그 모듈 예시 칩·S1·S6 카드·진입점 숨김 | 부분 | S/core/router.ts:52-75, W/modules/pantry/MyRequests.tsx:21-28, W/modules/rooms/index.tsx:49 | router.test.ts:79 | 카드(내 예약·내 요청)는 숨겨요. 예시 칩과 S4·S5 진입점은 그대로 보여요 |
| 스위치 화면: 회의실 쓰기 끔 | 주 버튼 그룹웨어 링크, 확인 시트 없음, 내 예약 칸 숨김 | 완료 | S/modules/rooms/service.ts:110-114, :274-276 | rooms.test.ts:509 | |
| 스위치 화면: 공지 요약·S5 목록만 | 늘 끔·늘 목록만 | 완료 | P/switches.ts:31-32 | — | |
| 스위치 화면: 단독 | 탭 둘, S3 첫 화면, S1·S5 숨김, S2는 미리보기로만, MCP 도구 빠짐 | 부분 | W/App.tsx:66, W/components/TabBar.tsx:12, P/switches.ts:50-53 | core.test.ts:65 · board.test.ts:195 | S5 진입점(W/screens/Mine.tsx:46)이 단독 모드에서도 보여요 |
| 스위치 화면: MCP 전체 끔 | 동의 시트 대신 "지금 연결할 수 있는 도구가 없어요", S6 같은 문구, 연결 줄 "쓸 수 있는 도구 없음" | 완료 | W/modules/mcp/index.tsx:66, :82, :134-137 | connections.test.ts:47 · oauth.test.ts:172 | |
| 스위치 화면: 회의실·공지 링크만·끔 + MCP | 도구 빠짐, 동의 시트 줄 빠짐, S6 "지금 꺼져 있어요" | 완료 | W/modules/mcp/index.tsx:79, :213-214 | mcp-route.test.ts:228 · policy.test.ts:34 | |
| 스위치 화면: 회의실 쓰기 끔 + MCP | 링크 "그룹웨어에서 예약하기", 동의 시트 "예약은 그룹웨어에서 해요", 다시 켜질 때 새 도구면 재동의 | 완료 | S/modules/mcp/mcp-route.ts:207, W/modules/mcp/index.tsx:213 | mcp-route.test.ts:122 · mcp-route.test.ts:242 | 승인 범위에 없는 도구는 403 insufficient_scope로 재동의를 받아요 |
| 카드 문법 | 다섯 칸(머리·본문·근거·행동·꼬리), 라벨 넷 글자, 색만으로 안 가름 | 완료 | P/cards.ts, S/core/cards.ts:4-29, W/components/CardView.tsx:19-83 | — | |
| 카드 "AI 정리" | AI가 고르거나 뽑은 카드에만, 확정·막힘·공지 카드엔 없음 | 완료 | S/modules/notices/service.ts:48, S/modules/rooms/cards.ts:91, :124 | notices.test.ts:32 · navi.test.ts:183 | |
| 카드 "틀렸어요" | 안내·제안 카드에만, 선택지 넷, 꼬리 문구 | 완료 | W/components/CardView.tsx:74-78, W/modules/navi/WrongSheet.tsx | navi.test.ts:260-309 | |
| 확인 버튼 잠김 | 누르면 잠기고 "○○하는 중", 두 번 눌러도 한 번 | 완료 | W/components/ActionHost.tsx:140-167, W/components/CardView.tsx:23-31, :66 | plans.test.ts:100 | "끊기·합치기"는 "처리하는 중"이에요 |
| 종류 칩·되묻기 | 확신 높으면 칩 1개(눌러서 바꿀 수 있음), 낮으면 최대 3 + "다른 거예요" | 부분 | W/components/ResultSheet.tsx:48-63 | — | 확신이 높을 때 칩은 표시만 해요(누를 수 없음). 바꾸려면 "틀렸어요 → 종류가 달라요"로 가야 해요 |
| 상태와 화면 | 실행 중·완료·막힘·만료(회의실 "다시 찾았어요"/게시 "다시 확인해 주세요")·취소됨 | 완료 | S/core/plans.ts:28, :107, S/modules/rooms/cards.ts:132-146 | plans.test.ts:118, :151 · board.test.ts:211 | |
| 카드 예: 담당·공지·공지 못 찾음·여기로 물어보세요·그룹웨어 링크 | 표의 머리·본문·근거·행동·꼬리 | 완료 | S/modules/navi/cards.ts, S/modules/notices/service.ts:37-65, S/core/router.ts:136-147 | navi.test.ts:53, :98 · notices.test.ts:32, :61 | |
| 카드 예: 회의실 후보·확정 | 방·층/날짜·시간/맞은 조건, 현황 기준, [이 방으로 예약]·조건 고치기 / 확정 카드 | 완료 | S/modules/rooms/cards.ts:38-56, :113-129 | rooms.test.ts:101, :210 | 조건 고치기는 조건 칩 카드가 맡아요 |
| 카드 예: 빈 방 없음 | "그 시간엔 빈 방이 없어요" + 대안 2(없으면 "가까운 시간에도 없어요") | 다르게 됨 | S/modules/rooms/cards.ts:58-71 | rooms.test.ts:173 | 코드는 "대안 없음"이에요. PRD F2-3도 "대안 없음"이라 화면설계 쪽 문구를 PRD에 맞추면 돼요(문서끼리 다름) |
| 카드 예: 막힘 | 회의실 "확인하는 사이에 …", 게시 "올릴 수 없는 글자가 있어요: [전화번호]" + 이름 고치기, 기능 꺼짐 "이 기능이 방금 꺼졌어요" + 그룹웨어 링크 | 다르게 됨 | S/modules/rooms/cards.ts:74-94, S/modules/pantry/cards.ts:62-73, S/core/plans.ts:210-221 | rooms.test.ts:313 · board.test.ts:134 · plans.test.ts:127 | 기능 꺼짐 카드가 "기능이 방금 꺼졌어요"이고 그룹웨어 링크가 없어요. 화면설계대로 고치는 게 맞아 보여요 |
| 카드 예: 같은 품목·공개 미리보기·주문안 줄 | 표의 다섯 칸 | 완료 | S/modules/pantry/cards.ts:14-60, W/modules/pantry/PreviewCard.tsx, W/modules/pantry/order/index.tsx:296-378 | board.test.ts:155 | |
| S1 배치·컴포넌트 | 띠 → 이름 → 내 예약 → 내 요청 → 예시 칩 → 가림 줄 → 입력창(아래 고정) → 원문 안내 링크 → 탭 | 완료 | W/screens/Ask.tsx:37-64, W/components/CheckedInput.tsx | — | 가림 줄은 입력창 아래에 붙어요(입력 칸 바로 아래라는 PRD와 맞음) |
| S1 빈·로딩·오류 | 빈 "아직 예약·요청이 없어요" 한 줄, 로딩은 S2 안, 키 잠금, 횟수 제한 문구, 네트워크 오류 → 글 유지 + [다시 보내기] | 부분 | W/modules/rooms/index.tsx:57, W/modules/pantry/MyRequests.tsx:48, W/screens/Ask.tsx:21-34, S/routes/ask.ts:24 | — | 빈 상태는 칸마다 "아직 예약이 없어요."·"아직 요청이 없어요."로 나뉘어요. 오류 때 글은 남지만 [다시 보내기] 버튼이 없어요 |
| S1 꺼진 모듈 | 꺼진 모듈의 예시 칩·카드 숨김 | 부분 | W/screens/Ask.tsx:10 | — | 예시 칩 3개가 고정이에요 |
| S2 배치·컴포넌트 | 손잡이 → 머리 칩 → 조건 칩 → 카드(회의실 최대 3) → 확인 시트(예약·취소만) | 완료 | W/components/ResultSheet.tsx, W/components/Sheet.tsx, W/modules/rooms/RoomConditionsCard.tsx | — | |
| S2 로딩 | "알아듣는 중" + 뼈대, 조건 고치면 "다시 찾는 중" | 완료 | W/components/ResultSheet.tsx:44-45, W/modules/rooms/RoomConditionsCard.tsx:113 | — | |
| S2 오류 | AI 실패 → "지금 답을 만들지 못했어요" + [다시 시도] + 총무 창구 링크 | 부분 | W/api.ts:93, W/screens/Ask.tsx:33 | — | 문구만 시트로 보여요. [다시 시도]·총무 창구 링크가 없어요(라우터는 LLM 실패 때 규칙으로 넘어가서 실제로 잘 안 닿아요) |
| S2 MCP 링크 진입 | 로그인 → 주인 검사 → 머리 문구 → 그 방 카드 → [이 방으로 예약] → 확인 시트, 찼으면 안내+대안, 만료면 다시 찾기, 남의 링크 문구 + [묻기에서 찾기] | 완료 | W/modules/mcp/index.tsx:251-296, S/modules/rooms/service.ts:184-221 | rooms.test.ts:532-610 | |
| S2 닫기 | 닫기·아래로 밀기·뒤로 가기 | 부분 | W/components/Sheet.tsx:4-24 | — | 닫기 버튼·바깥 누르기·Esc만 돼요. 아래로 밀기·브라우저 뒤로 가기가 없어요 |
| S3 배치 | 띠 → 머리(층·주기 마감 안내·총무 [운영]) → 요청 칸 → 가림 줄 → 내 표 줄 "N / 상한" → 품목(표 많은 순) → 지난 주기 결과 | 완료 | W/modules/pantry/BoardScreen.tsx:80-188 | board.test.ts:482 | |
| S3 품목 줄 | 이름·표 수·[+1]/[표 거두기]·카탈로그 맞춤·"같은 상품 같아요"·"합쳐진 이름: A, B", 투표자 없음 | 완료 | W/modules/pantry/BoardScreen.tsx:133-157 | board.test.ts:260, :405 | |
| S3 빈·로딩·오류 | 빈 문구, 몇 초 새로고침, 상한·상한 넘침·횟수 제한·건강 정보 문구 | 완료 | P/api/pantry.ts:15-32, W/modules/pantry/BoardScreen.tsx:120-130 | board.test.ts:227, :284, :313 | |
| S3 담당 질문 감지 | "이건 담당 안내가 맞아 보여요" + [묻기로 옮기기], 단독 모드 "여기에는 탕비실 요청만 올려요" | 완료 | S/modules/pantry/cards.ts:94-104 | board.test.ts:195 [F3-4] | |
| S3 역할별 | 직원은 내 층, 총무는 층 고르기 + [운영] | 완료 | W/modules/pantry/BoardScreen.tsx:88-104, S/modules/pantry/service.ts:332 | — | |
| S4 구역 넷 | 층·주기 선택, ① 합치기 제안함 ② 합친 기록 ③ 주문안 ④ 설정 | 완료 | W/modules/pantry/index.tsx:15-25, W/modules/pantry/MergePanel.tsx, W/modules/pantry/order/index.tsx | board.test.ts:386, :405, :428, :464 · order.test.ts | |
| S4 층 하나·빈·로딩·경고·충돌 | 층 하나면 최소 몫 숨김, 빈 문구 둘, 줄 먼저·설명 나중, 경고 셋, 충돌 문구 | 완료 | W/modules/pantry/MergePanel.tsx:111, :196, W/modules/pantry/order/index.tsx:47-62, :122, :158, :186-190, P/api/pantry-order.ts:13-21 | order.test.ts:149, :192 · board.test.ts:428 | |
| S4 폰 | 폰에서는 층별 합계와 [확정]만, 줄 고치기는 PC | 부분 | W/modules/pantry/order/index.tsx:21-31, :130-174 | — | 주문안 칸은 지켜요. 합치기 제안함·설정 칸은 폰에서도 다 보여요 |
| S5 목록 | 내 부서 행(기록 쌓인 행 먼저), 이유 넷별 건수, 누가 눌렀는지 없음 | 완료 | W/modules/navi/ChartScreen.tsx:26-101, S/modules/navi/service.ts:249-275 | navi.test.ts:376 | |
| S5 파일 다시 올리기 | 파일 고르기 → 바뀌는 행·칸 미리보기 → 확인 시트 [반영하기] → "반영했어요. 개정일이 올라갔어요." | 완료 | W/modules/navi/ChartScreen.tsx:104-259, S/modules/navi/service.ts:295-318 | navi.test.ts:447, :495 | |
| S5 빈·오류·폰 | "새로 쌓인 기록이 없어요.", "분장표 양식으로 올려 주세요", "다른 부서 행은 바뀌지 않아요", 폰은 목록만 | 완료 | W/modules/navi/ChartScreen.tsx:20, :61, :177-178, S/modules/navi/service.ts:118 | navi.test.ts:414, :439 | |
| S6 배치 | 내 예약 → 내 요청·표(상태) → 내 역할 → 연결된 AI 앱 → 무엇을 남기나요 → [모든 기기 로그아웃] → [로그아웃] | 완료 | W/screens/Mine.tsx:22-88 | — | |
| S6 내 요청 누르기 | S3 그 품목 줄로 | 부분 | W/modules/pantry/MyRequests.tsx:53 | — | 판으로는 가지만 그 줄로 스크롤하지 않아요 |
| S6 연결된 AI 앱 | 앱 이름·연결한 날·범위 칩·[끊기] → 확인 시트 → "끊었어요", 마지막 사용 없음 | 완료 | W/modules/mcp/index.tsx:42-126 | connections.test.ts:27, :58 | |
| S6 동의 시트 | S6 위 시트, 배치·문구, 허락/거절 결과, 허용 밖·도구 없음 문구 | 다르게 됨 | W/modules/mcp/index.tsx:142-243 | oauth.test.ts:79-172 | 단독 화면으로 떠요(4절 MCP 요구5) |
| S6 빈·오류·역할 | 칸마다 빈 문구, 취소 실패 → 막힘 카드, "내 역할"은 있는 사람만, 회의실 꺼지면 내 예약 숨김 | 부분 | W/modules/rooms/index.tsx:49-57, W/modules/pantry/MyRequests.tsx:48, W/modules/mcp/index.tsx:67, W/screens/Mine.tsx:37 | — | 취소 실패는 막힘 카드가 아니라 오류 문구 시트예요 |

## 12. 화면설계 핵심 흐름 ①~⑤

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| 흐름 ① | 담당 질문 → 담당 카드 → 틀렸어요 → S5 파일 다시 올리기 | 완료 | 1절 F1-3~F1-9 | navi.test.ts:53-509 | 브라우저 확인은 TEAM.md 5단계 몫 |
| 흐름 ② | 회의실 조건 → 후보 → 확인 → 막힘/대안 → 확정(쓰기 끔이면 링크) | 완료 | 2절 | rooms.test.ts:101-618 | |
| 흐름 ③ | 묻기 탕비실 → 같은 품목 +1 또는 공개 미리보기 → 게시·막힘·방금 올라옴·만료·올리지 않기, S3에서도 같은 미리보기, 게시 뒤 [판에서 보기] → 올린 줄 | 부분 | 3절 F3-2~F3-4 | board.test.ts:52-211 | [판에서 보기]가 판으로만 가고 올린 줄로 스크롤하지 않아요 |
| 흐름 ④ | 총무 S4 → 합치기·되돌리기 → 주문안 → 확정·내보내기 | 완료 | 3절 F3-8~F3-14 | board.test.ts:386-464 · order.test.ts | 7단계 알림은 다음 2주(R12) |
| 흐름 ⑤ | 외부 AI에서 회의실 찾기 → 동의 → 링크 → 앱에서 확인 예약 | 완료 | 4절 | connections.test.ts:77 [MCP-8] | claude.ai 실제 연결은 코드 밖(14절 9일 차(외부)) |

## 13. 화면설계 "보안이 보이는 문구" 표

웹 코드(`apps/web/src`)에서 글자를 grep했어요. 웹에 글자가 없으면 `packages/shared`(브라우저가 import)와 서버를 이어서 찾았어요. 서버 문구는 카드·시트·오류 메시지로 내려와 웹 공통 부품(CardView·ConfirmSheet·Sheet)이 그대로 그려요.

| 어디 | 문구 | 상태 | 웹 코드 grep | 글자가 있는 곳(파일:줄) | 메모 |
|---|---|---|---|---|---|
| S1 입력창 머리 | 나만 보여요 | 완료 | 있음 | W/screens/Ask.tsx:55 | |
| S1 입력창 안 | 이거 어디서 해요? 한 줄로 물어보세요 | 완료 | 있음 | W/screens/Ask.tsx:56 | |
| S1 입력창 아래 | 질문 원문은 저장하지 않아요 · 무엇을 남기나요 | 완료 | 있음 | W/screens/Ask.tsx:63 | 누르면 S6로 가요(무엇을 남기나요 칸으로 스크롤은 안 함) |
| 가림 줄(S1·S3) | 이메일 N곳, IP N곳을 [이메일] · [IP]로 바꿔 보내요 | 완료 | 없음(shared) | P/input-check/check.ts:37-43, 그림 W/components/CheckedInput.tsx:57 | 묻기·요청 칸 모두 CheckedInput이에요 |
| 키 잠금 | 키나 토큰처럼 보이는 글자가 있어서 보낼 수 없어요. 그 부분을 지우고 다시 보내 주세요 | 완료 | 없음(shared) | P/input-check/rules.ts:30, 그림 W/components/CheckedInput.tsx:58-62 | |
| 등급 3 차단 | 주민번호·비밀번호 같은 정보는 받지 않아요. 지우고 다시 보내 주세요 | 완료 | 없음(shared) | P/input-check/rules.ts:31 | |
| 건강 정보 차단(S1·S3·미리보기) | 알레르기 같은 건강 정보는 받지 않아요 | 완료 | 없음(shared) | P/input-check/rules.ts:32, 미리보기 P/api/pantry.ts:82-83 → W/modules/pantry/PreviewCard.tsx:65-69 | |
| S3 요청 쓰기 칸 머리 | 우리 층 모두에게 보여요 | 완료 | 있음(주석·상수 참조) | P/api/pantry.ts:16, 그림 W/modules/pantry/BoardScreen.tsx:108 | |
| S3 판 | 누가 표를 줬는지는 화면 어디에도 안 보여요 | 완료 | 없음(shared) | P/api/pantry.ts:17, 그림 W/modules/pantry/BoardScreen.tsx:159 | |
| 공개 미리보기 | '코카콜라 제로'라는 이름으로 우리 층 사람들에게 보여요. 내 이름은 안 보여요 | 완료 | 없음(shared) | P/api/pantry.ts:98-100, 그림 W/modules/pantry/PreviewCard.tsx:72 | 받침이 있으면 "이라는"으로 바꿔요 |
| 공개 미리보기 꼬리 | 처음 쓴 문장은 올라가지 않아요 | 완료 | 없음(shared) | P/api/pantry.ts:18, 그림 W/modules/pantry/PreviewCard.tsx:91 | 꼬리는 "… 내 이름은 안 보여요. 내 표 1개가 같이 들어가요"까지(카드 표와 같음) |
| 회의실 후보 근거 | 현황 HH:MM 기준 | 완료 | 없음(서버) | S/modules/rooms/cards.ts:17 | MCP 진입 머리는 웹에 있어요(W/modules/mcp/index.tsx:289) |
| 회의실 확인 시트 | 내 이름으로 예약돼요. 다른 사람에게는 '예약됨'으로만 보여요 | 완료 | 없음(서버) | S/modules/rooms/cards.ts:9, 시트 S/modules/rooms/service.ts:232-239 | |
| 회의실 확정 | HH:MM에 다시 확인하고 예약했어요 | 완료 | 없음(서버) | S/modules/rooms/cards.ts:124 | |
| 공통 띠 | 시연 데이터로 돌아가요(누르면 모의 목록) | 완료 | 있음 | W/components/DemoBand.tsx:10 | |
| AI 카드 근거 줄 | AI 정리 · 분장표 "○○" 행 · 개정일 | 완료 | "AI 정리"만 있음 | S/modules/navi/cards.ts:13-15, :39, 배지 W/components/CardView.tsx:54 | 무보관 계약 전에는 결정적으로 골라서 "AI 정리" 배지가 빠져요(R6 의도). 개정일 뒤에 날짜가 붙어요 |
| "틀렸어요" 시트 | 고른 결과만 남아요. 질문 원문은 남지 않아요 | 완료 | 있음 | W/modules/navi/WrongSheet.tsx:14 | |
| S6 무엇을 남기나요 | 남기는 것: … 남기지 않는 것: 묻기에 쓴 문장 | 완료 | 있음 | W/screens/Mine.tsx:57-63 | |
| S6 모든 기기 로그아웃 확인 | 모든 기기에서 로그아웃되고, 연결된 AI 앱도 모두 끊겨요. 다시 쓰려면 회사 계정으로 로그인해요 | 완료 | 있음 | W/screens/Mine.tsx:79 | |
| 동의 시트 머리 | Claude가 한 줄 데스크에 연결하려고 해요 · 회사가 허락한 앱이에요 | 완료 | 있음 | W/modules/mcp/index.tsx:201-204 | 앱 이름은 변수(+ 조사)예요 |
| 동의 시트 | 찾은 결과는 Claude의 AI 모델로 보내져요 | 완료 | 있음 | W/modules/mcp/index.tsx:227 | 앱 이름 변수, 접지 않아요 |
| 동의 시트 | 읽기만 해요. 예약·취소·게시는 못 해요 · 누가 예약했는지, 회의 제목은 보내지 않아요 | 완료 | 있음 | W/modules/mcp/index.tsx:221-222 | 두 줄로 나눴어요 |
| 동의 시트 꼬리 | 부른 도구와 시각만 남아요. … 퇴사하면 자동으로 끊겨요 | 완료 | 있음 | W/modules/mcp/index.tsx:239 | |
| 허용 목록 밖 | 회사가 허락하지 않은 앱이라 연결할 수 없어요 | 완료 | 있음 | W/modules/mcp/index.tsx:135 | |
| [끊기] 확인 시트 | Claude 연결을 끊어요. Claude에서 한 줄 데스크를 더 부를 수 없어요. 이미 Claude로 간 결과는 그쪽 기록에 남을 수 있어요 | 완료 | 있음 | W/modules/mcp/index.tsx:106 | 앱 이름 변수(+ 로/으로) |
| MCP 링크 진입(S2 머리) | Claude에서 가져온 후보예요. 지금 다시 확인했어요(현황 HH:MM 기준) | 완료 | 있음 | W/modules/mcp/index.tsx:289 | "Claude"가 고정 글자예요. 다른 클라이언트를 허용하면 바꿔야 해요 |
| 남의 링크 | 다른 사람이 받은 링크라 열 수 없어요 | 완료 | 있음 | W/modules/mcp/index.tsx:280, 서버 S/core/plans.ts:146 | |
| 세션 만료 | 보안을 위해 다시 로그인해 주세요 | 부분 | 없음 | 서버만 S/core/guard.ts:16 | 화면을 처음 열거나 새로 고칠 때 401이면 문구 없이 로그인 화면으로 가요(W/App.tsx:73-74, W/api.ts:68-71). 다른 요청이 401일 때만 결과 시트에 서버 문구가 보여요 |
| 스위치 "링크만" 카드 | 이 일은 그룹웨어에서 해요 | 완료 | 없음(서버) | S/core/router.ts:141 | |
| 주문안 확정 시트 | 주문에 들어간 품목의 표가 닫혀요. 나머지는 다음 주기로 넘어가요. 실제 주문은 내보낸 파일로 기존 절차대로 해 주세요 | 완료 | 없음(shared) | P/api/pantry-order.ts:20, 그림 W/modules/pantry/order/index.tsx:209 | |

## 14. 기획서 2주 일정

| 출처 | 요구 | 상태 | 코드(파일:줄) | 시험(파일·이름) | 메모 |
|---|---|---|---|---|---|
| 1일 | 저장소·배포 뼈대, 모의 OIDC, 끝 기준 "로그인 화면" | 완료 | W/screens/Login.tsx, S/routes/auth.ts, S/adapters/mock/employees.ts | app.test.ts:22, :27 | 앱 등록 신청·계약 확인·자료 요청·관문 개방 요청은 코드 밖이에요 |
| 2일 | 서버 세션, 모든 기기 로그아웃·세션 지우기, 감사 로그, 게이트웨이, 본문 빠진 로거 / 끝 기준 "카나리 DB·로그 0건" | 부분 | S/core/session.ts, S/core/audit.ts, S/core/ai/gateway.ts, S/app.ts:74-84 | app.test.ts:54, :75 | 로그 쪽 카나리 시험이 없어요 |
| 3일 | 입력창·공통 검사·라우터·칩 되묻기·카드 다섯 칸·제안 토큰·plan/확인 시트·"틀렸어요" / "다섯 종류로 나뉘는 빈 카드" | 완료 | S/core/router.ts, S/core/plans.ts, W/components | router.test.ts · plans.test.ts | |
| 4일 | F1 담당 / "근거 행 없는 카드 0건" | 완료 | S/modules/navi | navi.test.ts:117 | |
| 5일 | F1 공지, S5 / "주인이 다시 올려야만 반영" | 완료 | S/modules/notices, S/modules/navi | navi.test.ts:339 | |
| 6일 | F2 / "동시 확정 시 한 명만" | 완료 | S/modules/rooms | rooms.test.ts:313 | |
| 7일 | F3 판·S6, MCP 인가 시작 / "묻기 경로에서 판 쓰기 불가" | 완료 | S/modules/pantry, W/screens/Mine.tsx | board.test.ts:52, :73 | |
| 8일 | MCP 인가 마무리, F3 합치기 / "불변식 두 개, 토큰 대상·미등록 거부" | 완료 | S/modules/mcp, S/modules/pantry | invariants.test.ts:86 · oauth.test.ts:269, :349 | |
| 9일 | F3 주문안·정수 계획 비교·주기, MCP 엔드포인트·도구 둘·S6·보안 시험 / "검사기 통과, MCP 시연 흐름" | 완료 | S/modules/pantry/order, S/modules/mcp | order.test.ts · plan-compare.test.ts · connections.test.ts:77 | 반례(F3 완료6)는 이 날 결정할 일이었어요 |
| 9일(외부) | claude.ai 실제 연결 | 없음(코드 밖) | — | — | 보안팀 대역 개방·조직 커넥터 등록이 필요해요 |
| 10일 | 측정(담당 정답률·합치기·라우터 경계), 주입 시험, 리허설 / "측정표" | 없음(일정상 나중) | — | — | |
| 잴 것(10일 차·시연 전) | 정답률·근거 없는 카드·경계 문장·합치기 정답 쌍·주문안 검사기·MCP 호출 결과·MCP 거부 이유·퇴사 차단 시간·AI 비용·지연 | 없음(일정상 나중) | S/core/audit.ts, S/core/ai/gateway.ts:75-83 | oauth.test.ts:438, :447(퇴사 차단 시간) | 감사 로그·비용 표로 셀 재료는 있어요. MCP 거부는 결과가 `refused` 하나라 "미등록·대상 불일치·만료·퇴사·횟수 초과별" 이유를 나눠 셀 수 없어요. 지연은 재지 않아요 |

---

## 15. 빠진 것(우선순위 순)

1. **판 요청 글을 등급 0으로 LLM에 보냄**(5절 AI 게이트웨이, ADR-10·R6): `S/modules/pantry/similarity.ts:124, :158, :192`, `order/explain.ts:106`이 등급을 0으로 못 박아요. 실제 모델로 켜면 무보관 계약 전에도 직원이 쓴 요청 문장이 나가요. 어댑터 mock 여부로 등급을 정하거나 요청 원문은 등급 1로 보내야 해요.
2. ~~주문안 "못 받은 층 0건" 반례~~ → 10/26 D8 1단계 보정으로 해결했어요(F3 완료6).
3. **끄기 스위치 웹 반영**(R4, ADR-12): 꺼진 모듈의 예시 칩, S4·S5 진입점(단독 모드 S5 포함)이 그대로 보여요.
4. **운영 설정값 바꾸기 경로와 감사 로그**(F2-1, ADR-12): 회의 길이 기본값·만료·횟수 상한·재확인 간격을 운영자가 바꿀 길이 없고, 운영 설정이 서버 메모리에만 있어요.
5. **DB 읽기 역할 분리**(ADR-04·ADR-10): 묻기·초안 경로 역할, 운영자가 투표 표·승인 토큰 해시를 못 읽게 하는 역할이 없어요(`D/001_base.sql:144-145` "다음에 할 것").
6. **원문 카나리 시험 빈칸**(F1 완료3, ADR 시험 10·11, 2일 차 기준): 앱 로그·오류 응답·URL 카나리, 입력창 자동 완성 꺼짐 시험이 없어요.
7. **운영자 몫 운영 표**(PRD 역할 표, ADR-10): 10명 이상 묶음 통계, 오류 표, MCP 거부 이유별 셈이 없어요.
8. **MCP 클라이언트 등록 경로**(MCP 요구4, ADR-15): 보안팀 승인 클라이언트를 운영자가 넣을 길이 없어요(시연 클라이언트 seed만).
9. **세션 만료 문구**(보안 문구 표): "보안을 위해 다시 로그인해 주세요"가 웹에 없어 첫 화면 401에서 안 보여요.
10. **바닥 시트 뒤로 가기 닫기**(PRD 접근성, S2): 브라우저 뒤로 가기·아래로 밀기로 닫히지 않아요.
11. 묻기(`/api/ask`) 429 시험, 모듈별 LLM 입력 스냅샷 시험(ADR 시험 13·01·10).
12. S2 AI 실패 때 [다시 시도]·총무 창구 링크, S1 네트워크 오류 [다시 보내기].
13. 기능 꺼짐 막힘 카드 문구("이 기능이 방금 꺼졌어요")와 그룹웨어 링크.
14. 확신 높을 때 종류 칩을 눌러 바꾸기(S2 카드 문법).
15. 공지·카탈로그 파일 가져오기 경로(ADR-05), IdP 그룹 없을 때 역할 표(R17 대안), 도구 레지스트리의 출력 스키마·필요 권한 칸(ADR-01).
16. 동의 시트를 S6 위 시트로(또는 화면설계 수정), [판에서 보기]·내 요청 → 그 줄로 스크롤, S4 합치기 칸 폰 제한, S6 취소 실패 막힘 카드.
17. 문서 손볼 것: "틀렸어요" 시각 → 날짜(F1-8), 묻기 감사 결과에 `reask`·`link` 추가, 빈 방 없음 카드 "대안 없음"으로 화면설계 맞추기, S1 빈 상태 문구.

일정상 나중(10일 차·다음 2주): 담당 정답률·경계 문장 측정표, 주입 시험, 리허설, 알림·알림 주소 표(R12), claude.ai 실제 연결(코드 밖).
