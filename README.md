# 한 줄 데스크 (One_line_desk)

회의실 잡기, 탕비실 채우기, 누구한테 물을지. 한 줄 쓰면 확인 카드로 돌려주는 사내 안내 데스크예요.
회의실·공지(회사생활 MCP 일부) + 같이 채워요(탕비실) + 담당자 내비를 하나로 합쳤어요.

- 기획 문서: [docs/기획서.md](docs/기획서.md) · [docs/PRD.md](docs/PRD.md) · [docs/화면설계.md](docs/화면설계.md) · [docs/ADR.md](docs/ADR.md) · [docs/회의종합.pdf](docs/회의종합.pdf)
- 상태: **초반틀**이에요. 2주 일정의 1일 차 끝 기준("로그인 화면")과 공통 바닥 일부까지 있어요. PRD는 아직 초안이에요(사용자 확인 3개·보안팀 질문 2개 대기).

## 실행

Node 22 이상과 npm이 필요해요.

```bash
npm install
npm run dev
```

웹은 http://localhost:5190, 서버는 http://localhost:3190 이에요. 가상 직원 다섯 명 중 하나를 골라 모의 로그인해요.

DB가 필요할 때(Docker):

```bash
cp .env.example .env
npm run db:up
npm run db:migrate
```

`.env`가 없거나 `DATABASE_URL`이 비어 있으면 서버는 DB 없이 떠요. `/health`에 `"db":"none"`으로 나와요.

시험과 타입 검사:

```bash
npm test
npm run typecheck
```

## 폴더

| 폴더 | 하는 일 | 근거 |
|---|---|---|
| `packages/shared` | 브라우저와 서버가 같이 쓰는 것: 공통 입력 검사 규칙, 종류·역할 이름, 카드 다섯 칸, 끄기 스위치, 데이터 등급 | ADR-02·11·12, R7 |
| `apps/server` | Fastify 서버. `core/`(세션·가명 ID·감사 로그·AI 게이트웨이·plan 상태·요청 횟수·도구 레지스트리·운영 설정), `adapters/`(모의 OIDC·디렉터리), `routes/`, `db/` | ADR-01·03·05·10·13 |
| `apps/server/src/modules` | 모듈 넷(navi·notices·rooms·pantry)이 들어올 자리. 지금은 [README](apps/server/src/modules/README.md)만 있어요 | ADR-01 |
| `apps/web` | React(Vite) 웹. 로그인, 탭 셋(묻기 / 같이 채워요 / 내 것), 시연 데이터 띠, 입력 칸 아래 가림 줄 | D4, 화면설계 |
| `db/migrations` | PostgreSQL 표 초안. 회의실 겹침 제약(btree_gist) 포함 | ADR-06·07·09·15 |
| `docs` | 기획서·PRD·화면설계·ADR·회의 종합 | |

## 지금 되는 것

- 모의 OIDC 로그인 → 서버 세션(httpOnly 쿠키, 8시간), 가명 ID, 역할은 요청마다 계산
- 재직 재확인: 정해진 간격이 지난 뒤 첫 요청에서 퇴사자 세션을 모두 지워요
- 모든 기기 로그아웃, 쓰기 요청의 CSRF 토큰 확인
- 공통 입력 검사: 키·토큰·주민번호·비밀번호 값·건강 정보는 잠그고, 이메일·IP는 `[이메일]`·`[IP]`로 바꿔 보내요. 서버도 같은 규칙으로 다시 검사해요
- `/api/ask`: 서버 검사와 감사 로그(내용 칸 없음)까지. 라우터는 501로 비워 뒀어요
- 운영 설정 읽기·모듈 스위치 바꾸기(운영자만, 감사 로그에 남음), MCP 도구 목록 계산(기본 꺼짐)
- DB 마이그레이션 적용 스크립트(한 번만 적용)

## 아직 안 만든 것 (기획서 2주 일정 기준)

| 날 | 할 일 |
|---|---|
| 2일 | 세션·감사 로그를 DB로, AI 게이트웨이 모델 연결(무보관 모델 고정), 본문 빠진 로거, 원문 카나리 시험 |
| 3일 | 앞문 라우터(규칙 + LLM 한 번), 칩 되묻기, 카드 다섯 칸, 제안 토큰, plan·확인 시트, "틀렸어요" |
| 4~5일 | F1 담당 카드(분장표 가져오기, 행 ID만 고르기), 공지 찾기·원문 링크, S5 목록 + 파일 다시 올리기 |
| 6일 | F2 회의실(모의 장부, 후보·대안, 확정 재확인, 내 예약·취소) |
| 7~9일 | F3 같이 채워요(게시·+1·합치기·주문안·주기), S4 총무 운영, MCP 인가 서버·도구 둘·S6 연결된 AI 앱 |
| 10일 | 측정, 주입 시험, 리허설 |

## 정해 둔 기술

- TypeScript, npm workspaces(사용자 터미널에 pnpm이 없어서), Fastify 5, React 19 + Vite, PostgreSQL(로컬은 Docker `postgres:17`, 포트 5433), Vitest
- 서버 포트는 `SERVER_PORT`(기본 3190)로 받아요. `PORT`는 미리보기 도구·호스팅이 웹 포트로 넘기는 경우가 있어서 쓰지 않아요
- 운영 설정의 기본 회의 길이·토큰 만료·횟수 상한은 아직 정하지 않은 임시값이에요(`packages/shared/src/switches.ts`)
