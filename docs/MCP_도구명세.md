# MCP 도구 노출 명세

> 이 문서는 `apps/server/src/core/tool-registry.ts`와 `apps/server/src/modules/mcp/tool-impls.ts`에서 만들어요(`npm run mcp:spec`). 손으로 고치지 않아요.

- 모든 도구는 읽기만 해요. 쓰기 도구는 0개예요(ADR-03·14). 예약 같은 쓰기는 결과의 앱 확인 링크를 사람이 열어 앱에서 한 번 확인해요.
- 출력은 아래 칸만 나가요. 서비스가 다른 칸을 실어 보내도 출력 스키마(`.strict()`)와 모양 함수가 버려요.
- 실제(모의가 아닌) 자료는 보안팀이 승인한 클라이언트에만 가요(ADR-15). 도구 호출마다 감사 로그(도구·클라이언트·결과, 7일)와 접속기록(가명 ID·접속지, 1년)이 남아요. 입력 값은 어디에도 남지 않아요.
- 운영자는 MCP 전체·모듈·도구 하나씩 끌 수 있어요(`/api/ops/flag`, `/api/ops/switch`, `/api/ops/mcp-tool`).

범위: `rooms.read`, `notices.read`

| 도구 | 이름 | 범위 | 모듈 | 일부러 내보내지 않는 칸 |
|---|---|---|---|---|
| `notices_search` | 공지 찾기 | `notices.read` | notices | 공지 본문, 발췌·요약, 작성자 |
| `rooms_find_free` | 빈 회의실 찾기 | `rooms.read` | rooms | 예약자, 회의 제목, 방별 하루 일정, 참석자 |

## `notices_search` — 공지 찾기

허용 게시판 공지의 제목·게시일·원문 링크만 찾아요. 본문·요약은 돌려주지 않으니, 내용은 원문 링크에서 확인하라고 안내해 주세요. 하나도 없으면 emptyReason에 찾아본 게시판이 있어요.

- 범위: `notices.read` · 꺼지는 조건: MCP 전체 끔, notices 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 공지 본문, 발췌·요약, 작성자

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `query` | string(최대 100자) | 예 | 검색어 |

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `mock` | boolean | 예 | 가상 공지(시연 데이터)인지 |
| `hits` | 목록(최대 5) | 예 |  |
| `hits[].title` | string | 예 |  |
| `hits[].postedOn` | string | 예 |  |
| `hits[].url` | string | 예 |  |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |

## `rooms_find_free` — 빈 회의실 찾기

빈 회의실 후보 최대 3개(인원에 가장 꼭 맞는 회의실부터)와 앱 확인 링크를 돌려줘요. 후보마다 정원·장비·설비가 있어요. 예약자·회의 제목은 없어요. 후보가 없으면 emptyReason에 까닭이 있고, 가까운 시간 대안을 최대 2개 줘요.

- 범위: `rooms.read` · 꺼지는 조건: MCP 전체 끔, rooms 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 예약자, 회의 제목, 방별 하루 일정, 참석자

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `date` | string | 예 | YYYY-MM-DD |
| `start` | string | 예 | HH:MM |
| `minutes` | integer(15~480) |  | 회의 길이(분). 비우면 운영 설정 기본값 |
| `people` | integer(1~100) | 예 | 인원 |
| `equipment` | 목록(최대 3) |  | 정해진 장비 목록 중에서: 화면, 화상회의, 화이트보드 |
| `floor` | string |  | 층(예: 3층) |

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `checkedAt` | string | 예 | 현황 조회 시각(ISO) |
| `checkedAtLabel` | string | 예 | 현황 HH:MM 기준 |
| `mock` | boolean | 예 | 모의 장부(시연 데이터)인지 |
| `candidates` | 목록(최대 3) | 예 |  |
| `candidates[].roomId` | string | 예 |  |
| `candidates[].roomName` | string | 예 |  |
| `candidates[].floor` | string | 예 |  |
| `candidates[].date` | string | 예 |  |
| `candidates[].start` | string | 예 |  |
| `candidates[].end` | string | 예 |  |
| `candidates[].matched` | 목록 | 예 |  |
| `candidates[].capacity` | integer(1 이상) |  | 정원(명) |
| `candidates[].equipment` | 목록 | 예 | 정해진 장비 목록 중 갖춘 것 |
| `candidates[].facilities` | 목록 | 예 | 장부에 적힌 설비(예: TV 모니터 75인치) |
| `candidates[].link` | string | 예 |  |
| `candidates[].linkText` | string | 예 |  |
| `alternatives` | 목록(최대 2) | 예 |  |
| `alternatives[].roomId` | string | 예 |  |
| `alternatives[].roomName` | string | 예 |  |
| `alternatives[].floor` | string | 예 |  |
| `alternatives[].date` | string | 예 |  |
| `alternatives[].start` | string | 예 |  |
| `alternatives[].end` | string | 예 |  |
| `alternatives[].matched` | 목록 | 예 |  |
| `alternatives[].capacity` | integer(1 이상) |  | 정원(명) |
| `alternatives[].equipment` | 목록 | 예 | 정해진 장비 목록 중 갖춘 것 |
| `alternatives[].facilities` | 목록 | 예 | 장부에 적힌 설비(예: TV 모니터 75인치) |
| `alternatives[].link` | string | 예 |  |
| `alternatives[].linkText` | string | 예 |  |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |
