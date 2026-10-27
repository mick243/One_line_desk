# 한 줄 데스크 (One_line_desk)

회의실 잡기, 탕비실 채우기, 누구한테 물을지. 한 줄 쓰면 확인 카드로 돌려주는 사내 안내 데스크예요.
회의실·공지(회사생활 MCP 일부) + 같이 채워요(탕비실) + 담당자 내비를 하나로 합쳤어요.

- 기획 문서: [docs/기획서.md](docs/기획서.md) · [docs/PRD.md](docs/PRD.md) · [docs/화면설계.md](docs/화면설계.md) · [docs/ADR.md](docs/ADR.md) · [docs/회의종합.pdf](docs/회의종합.pdf)
- 개발 문서: [docs/CONVENTIONS.md](docs/CONVENTIONS.md)(코드 컨벤션) · [docs/TEAM.md](docs/TEAM.md)(에이전트 팀과 맡은 곳) · [docs/REVIEW.md](docs/REVIEW.md)(보안·QA 검토) · [docs/TRACEABILITY.md](docs/TRACEABILITY.md)(요구사항 추적표)
- 상태: 네 기능(담당·공지, 회의실, 같이 채워요, 읽기 전용 MCP)이 **가상 자료(등급 0)와 모의 어댑터**로 돌아가요. PRD는 아직 초안이에요(사용자 확인 3개·보안팀 질문 2개 대기). 실제 그룹웨어·IdP 연결과 10일 차 측정은 아직이에요.

## 실행

Node 22 이상과 npm이 필요해요.

```bash
npm install
npm run dev
```

웹은 http://localhost:5190, 서버는 http://localhost:3190 이에요. 가상 직원 다섯 명 중 하나를 골라 모의 로그인해요.

- DB: `DATABASE_URL`이 없으면 내장 PGlite(`.data/pglite`)를 써요. 서버가 뜰 때 마이그레이션을 적용하고, 비어 있으면 가상 자료(분장표·공지·회의실 장부·탕비실 카탈로그와 요청)를 넣어요. 처음부터 다시 하려면 서버를 끄고 `.data/`를 지워요.
- 실제 PostgreSQL: `cp .env.example .env` → `npm run db:up`(Docker, 5433) → `DATABASE_URL` 설정 → `npm run db:migrate`
- AI: 기본은 모델을 부르지 않는 `fake`예요(규칙과 틀 문장으로 돌아가요). 실제 모델은 `DESK_AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, 무보관 계약 확인 뒤 `NO_RETENTION_CONTRACT_CONFIRMED=true`예요. 모델은 ADR-10대로 `claude-opus-5-5` 하나로 고정해요(`DESK_AI_MODEL`).
- 임시 IdP(Keycloak): `npm run idp:up`(Docker, http://localhost:8180) → `npm run dev:idp`. 로그인 화면이 "회사 계정으로 로그인"이 되고, 직원 명단(참석자 검색)도 IdP에서 와요. 가상 직원 15명이고 아이디는 `idp/realm-one-line-desk.json`, 비밀번호는 모두 `desk-demo`예요(로컬 시험용). 끄려면 `npm run idp:down`.
- 회의 초대(ADR-17): 그룹웨어 캘린더·Slack은 기본이 모의예요(내 것 > 시연 받은편지함에서 보여요). `SLACK_BOT_TOKEN`을 넣으면 실제 Slack DM을 보내요(보관 조건·보안 승인 뒤에만).
- MCP: 운영자(가상 운영자 민준)가 MCP 스위치를 켜야 열려요. 시연용 클라이언트는 개발 환경에서만 넣어요(`apps/server/src/modules/mcp/index.ts`).

검사:

```bash
npm run check
```

서식 검사(Prettier) + 타입 검사 + 시험(공유 10개, 서버 299개)을 한 번에 돌려요. 동시성 시험은 아직 PGlite(연결 하나)에서만 돌아요. 실제 PostgreSQL 경쟁 시험은 다음 일이에요([docs/REVIEW.md](docs/REVIEW.md) M1).

## 기능과 화면

| 기능 | 되는 것 | 화면 |
|---|---|---|
| 홈 | "○○님, 무엇을 할까요?" + 할 수 있는 일 목록(누르면 그 기능 페이지), 내 예약·내 요청 요약. 기능마다 페이지가 따로 있어요(10/26, ADR-02 개정). 날짜는 "다음 주 화요일"·"금요일"·"3일 뒤"·"11/3"·"15:30" 같은 말도 알아들어요 | 홈 |
| F1 담당 찾기·공지 | 분장표 행 원문 카드(사람 이름 없음), "여기로 물어보세요", 공지 제목·게시일·원문 링크, "틀렸어요" 익명 기록, 분장표 주인의 파일 다시 올리기. 담당 팀에 문의·사유 보내기(확인 시트, 90일 보관) → 받은 문의함·처리 상태, 앱 안 알림 종(ADR-16) | 담당 찾기 페이지, S5 |
| F2 회의실 | 모의 장부(예약자·제목 버림), 조건 칩, 후보 3개·대안 2개, 확인 시트 → 확정 순간 재확인(겹침 제약), 내 예약·취소. "모든 회의실": 방 카드(그림·정원·지금 상태) → 방 자세히(설비·하루 일정·이 시간 예약), 남의 예약은 "예약됨"만 | 회의실 페이지·S6 |
| F3 같이 채워요 | 공개 미리보기로만 게시, +1·표 거두기(1인 1표·상한), 같은 상품 표시, 총무 합치기·되돌리기, 예산 안 주문안(층 몫을 정확히 지키는 탐욕법 + 이유 코드, D8 1단계 보정), 확정·CSV 내보내기 | S3 판, S4 총무 운영 |
| MCP | OAuth 인가 서버(PKCE S256, 등록 클라이언트만), `/mcp` 읽기 도구 둘(rooms_find_free·notices_search), 동의 시트, 앱 확인 링크, 연결 끊기·퇴사 자동 끊김 | 동의 시트, S6 연결된 AI 앱 |

## 폴더

| 폴더 | 하는 일 |
|---|---|
| `packages/shared` | 브라우저와 서버가 같이 쓰는 것: 입력 검사 규칙, 카드 타입, 모듈별 API 타입, 스위치, 시간 도우미 |
| `apps/server/src/core` | 공통 바닥: DB(PGlite·pg), AI 게이트웨이, 감사 로그, 제안 토큰, plan, 고정 버튼, 라우터, 가드, 운영 설정 |
| `apps/server/src/modules` | navi · notices · rooms · pantry(+ order) · mcp. 모듈끼리는 `core/services.ts`로만 이어져요 |
| `apps/web/src` | React 웹. `components/`(카드·시트·행동·탭), `screens/`(홈·기능 페이지·로그인·내 것), `modules/`(모듈 화면) |
| `db/migrations` | 영역별 번호(0xx 공통 · 1xx navi · 2xx notices · 3xx rooms · 4xx pantry · 5xx mcp) |
| `.claude/agents` | 에이전트 팀 정의(모듈 개발·검토·추적) |

## 정해 둔 기술

- TypeScript 7, npm workspaces, Fastify 5, React 19 + Vite, PGlite 또는 PostgreSQL, Vitest, Prettier
- 린트 도구(Biome)는 회사 PC의 응용 프로그램 제어에 막혀서 쓰지 않아요. 대신 엄격한 tsc 옵션과 규칙 시험(`core/conventions.test.ts`)으로 막아요
- 서버 포트는 `SERVER_PORT`(기본 3190)로 받아요. `PORT`는 미리보기 도구·호스팅이 웹 포트로 넘기는 경우가 있어서 쓰지 않아요
- 운영 설정의 기본 회의 길이·토큰 만료·횟수 상한은 아직 정하지 않은 임시값이에요(`packages/shared/src/switches.ts`). 운영자가 `PUT /api/ops/switch`·`/api/ops/flag`·`/api/ops/values`·`/api/ops/link`로 바꾸면 `ops_settings` 표에 남아서 서버를 다시 켜도 그대로예요. 운영(production)은 회의실 쓰기·MCP를 끈 출시 기본값에서 시작해요(CD-14)
- 담당 찾기 `끔`은 공지·회의실이 모두 꺼진 같이 채워요 단독 모드에서만 돼요(409, ADR-12)
