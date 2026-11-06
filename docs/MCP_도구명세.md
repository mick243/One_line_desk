# MCP 도구 노출 명세

> 이 문서는 `apps/server/src/core/tool-registry.ts`와 `apps/server/src/modules/mcp/tool-impls.ts`에서 만들어요(`npm run mcp:spec`). 손으로 고치지 않아요.

- 모든 도구는 읽기만 해요. 쓰기 도구는 0개예요(ADR-03·14). 예약 같은 쓰기는 결과의 앱 확인 링크를 사람이 열어 앱에서 한 번 확인해요.
- 출력은 아래 칸만 나가요. 서비스가 다른 칸을 실어 보내도 출력 스키마(`.strict()`)와 모양 함수가 버려요.
- 실제(모의가 아닌) 자료는 보안팀이 승인한 클라이언트에만 가요(ADR-15). 도구 호출마다 감사 로그(도구·클라이언트·결과, 7일)와 접속기록(가명 ID·접속지, 1년)이 남아요. 입력 값은 어디에도 남지 않아요.
- 운영자는 MCP 전체·모듈·도구 하나씩 끌 수 있어요(`/api/ops/flag`, `/api/ops/switch`, `/api/ops/mcp-tool`).

범위: `rooms.read`, `notices.read`, `navi.read`, `mine.read`, `leave.prepare`, `pantry.read`

| 도구 | 이름 | 범위 | 모듈 | 일부러 내보내지 않는 칸 |
|---|---|---|---|---|
| `notices_search` | 공지 찾기 | `notices.read` | notices | 공지 본문, 발췌·요약, 작성자 |
| `rooms_find_free` | 빈 회의실 찾기 | `rooms.read` | rooms | 예약자, 회의 제목, 방별 하루 일정, 참석자 |
| `navi_find_team` | 받을 팀 찾기 | `navi.read` | navi | 분장표 행 ID, 주인 부서, 담당자 이름, 질문 글(어디에도 남지 않아요), 남은 연차 |
| `navi_it_faq` | IT 오류 FAQ 찾기 | `navi.read` | navi | 붙여 넣은 오류 글(어디에도 남지 않아요), FAQ 내부 번호, 분장표 행 ID |
| `navi_onboarding` | 첫 2주 할 일 | `navi.read` | navi | 분장표 행 ID, 주인 부서, 담당자 이름, 진행 여부(저장하지 않아요) |
| `my_requests_status` | 내 요청 상태 | `mine.read` | navi | 문의·답장·반려 사유 글, 답한 사람 이름, 휴가 날짜와 남은 연차, 다른 사람의 요청, 참석자 |
| `leave_prepare` | 휴가 신청 준비 | `leave.prepare` | navi | 남은 연차, 올해 병가 쓴 날, 사유(앱에서 직접 골라요), 받는 팀 담당자 이름 |
| `pantry_find_similar` | 탕비실 요청 찾기 | `pantry.read` | pantry | 표를 준 사람, 요청을 올린 사람, 찾은 품목 이름(어디에도 남지 않아요), 다른 층 판 |
| `rooms_find_equipment` | 장비 대여 확인 | `rooms.read` | rooms | 빌린 사람, 장비별 대여 일정, 장비 보관 위치 |

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

## `navi_find_team` — 받을 팀 찾기

업무 분장표에서 이 일을 어느 팀에 물어야 하는지 후보 최대 3개(업무·담당 팀·창구·지금 할 일·처리 기간·개정일)를 돌려줘요. 사람 이름은 없어요. 후보마다 문의 양식 앱 링크가 있어요. 링크는 받을 팀만 담고 질문 글은 담지 않아서, 사람이 앱에서 내용을 직접 써서 [보내기]를 눌러요. 확정은 앱에서 한 번이에요. 맞는 업무가 없으면 emptyReason과 대표 창구 문의 링크를 줘요. 분장표에 없는 내용을 지어내지 말아 주세요.

- 범위: `navi.read` · 꺼지는 조건: MCP 전체 끔, navi 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 분장표 행 ID, 주인 부서, 담당자 이름, 질문 글(어디에도 남지 않아요), 남은 연차

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `query` | string(최대 300자) | 예 | 무슨 일인지 한 줄(예: 법인카드를 잃어버렸어요) |

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `mock` | boolean | 예 | 가상 분장표(시연 데이터)인지 |
| `candidates` | 목록(최대 3) | 예 |  |
| `candidates[].task` | string | 예 | 업무 |
| `candidates[].team` | string | 예 | 담당 팀(사람 이름 없음) |
| `candidates[].desk` | string | 예 | 팀 창구(팀 메일·채널 같은 창구 글) |
| `candidates[].nextStep` | string | 예 | 지금 할 일 |
| `candidates[].processingPeriod` | string |  | 처리 기간 |
| `candidates[].revisedOn` | string | 예 | 분장표 개정일 YYYY-MM-DD |
| `candidates[].match` | 정해진 값(2개) | 예 | strong: 분장표 근거가 뚜렷해요 · weak: 비슷한 후보예요 |
| `candidates[].link` | string | 예 | 앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요 |
| `candidates[].linkText` | string | 예 |  |
| `general` | object |  | 맞는 업무가 없을 때: 분장표에 없는 일을 받는 대표 창구 |
| `general.team` | string | 예 |  |
| `general.desk` | string | 예 |  |
| `general.link` | string | 예 | 앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요 |
| `general.linkText` | string | 예 |  |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |
| `confirm` | string | 예 | 사람에게 같이 전할 안내 |

## `navi_it_faq` — IT 오류 FAQ 찾기

IT 오류 창의 글로 사내 IT FAQ를 찾아 원문 단계를 그대로 돌려줘요. 단계를 고치거나 지어내지 말고 그대로 전해 주세요. 오류 글에 든 이메일·사용자 폴더 같은 값은 가린 뒤 찾고, 글은 어디에도 남지 않아요. 키·비밀번호·주민번호가 든 글은 거절해요. 안 풀리면 IT 담당 팀 문의 양식 앱 링크를 열어 사람이 직접 보내요(확정은 앱에서 한 번).

- 범위: `navi.read` · 꺼지는 조건: MCP 전체 끔, navi 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 붙여 넣은 오류 글(어디에도 남지 않아요), FAQ 내부 번호, 분장표 행 ID

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `text` | string(최대 1000자) | 예 | 오류 창에 뜬 글 |

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `mock` | boolean | 예 | 가상 FAQ(시연 데이터)인지 |
| `faq` | object |  |  |
| `faq.title` | string | 예 |  |
| `faq.steps` | 목록(최대 20) | 예 | FAQ 원문 단계(고치지 않고 그대로) |
| `faq.revisedOn` | string | 예 |  |
| `others` | 목록(최대 3) | 예 | 비슷한 다른 FAQ 제목 |
| `inquiry` | object | 예 | 안 풀리면: IT 담당 팀 문의 양식 앱 링크(글은 사람이 앱에서 써요) |
| `inquiry.team` | string | 예 |  |
| `inquiry.task` | string | 예 |  |
| `inquiry.link` | string | 예 | 앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요 |
| `inquiry.linkText` | string | 예 |  |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |

## `navi_onboarding` — 첫 2주 할 일

신규 입사자가 첫 1주·2주에 할 일 목록(업무·담당 팀·창구·지금 할 일·처리 기간)을 돌려줘요. 누구나 읽는 안내이고, 신규 입사자인지는 묻지도 판단하지도 않아요.

- 범위: `navi.read` · 꺼지는 조건: MCP 전체 끔, navi 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 분장표 행 ID, 주인 부서, 담당자 이름, 진행 여부(저장하지 않아요)

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `mock` | boolean | 예 | 가상 분장표(시연 데이터)인지 |
| `weeks` | 목록 | 예 |  |
| `weeks[].week` | integer(1~2) | 예 | 첫 몇 주 차 |
| `weeks[].items` | 목록(최대 30) | 예 |  |
| `weeks[].items[].task` | string | 예 | 업무 |
| `weeks[].items[].team` | string | 예 | 담당 팀(사람 이름 없음) |
| `weeks[].items[].desk` | string | 예 | 팀 창구(팀 메일·채널 같은 창구 글) |
| `weeks[].items[].nextStep` | string | 예 | 지금 할 일 |
| `weeks[].items[].processingPeriod` | string |  | 처리 기간 |
| `weeks[].items[].revisedOn` | string | 예 | 분장표 개정일 YYYY-MM-DD |
| `appLink` | string | 예 | 앱의 첫 2주 할 일 화면 |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |

## `my_requests_status` — 내 요청 상태

연결한 사람 본인이 보낸 문의·휴가 요청의 업무 이름·받은 팀·상태·보낸 날·답장 있음 여부와, 본인의 다가오는 회의실 예약(방·시간)을 돌려줘요. 문의·답장 글은 없어서 내용은 앱에서 확인하라고 안내해 주세요. 취소·답장은 앱에서 해요.

- 범위: `mine.read` · 꺼지는 조건: MCP 전체 끔, navi 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 문의·답장·반려 사유 글, 답한 사람 이름, 휴가 날짜와 남은 연차, 다른 사람의 요청, 참석자

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `mock` | boolean | 예 | 시연 데이터인지 |
| `requests` | 목록(최대 30) | 예 | 최근 7일 안에 보낸 것(그보다 오래된 것은 지워져요) |
| `requests[].kind` | 정해진 값(3개) | 예 |  |
| `requests[].task` | string | 예 | 업무 이름 |
| `requests[].team` | string | 예 | 받은 팀 |
| `requests[].state` | string | 예 | 처리 상태 |
| `requests[].sentOn` | string | 예 | 보낸 날 YYYY-MM-DD |
| `requests[].hasReply` | boolean | 예 | 답장이 왔는지(글은 앱에서 봐요) |
| `reservations` | 목록(최대 20) | 예 | 다가오는 내 회의실 예약 |
| `reservations[].roomName` | string | 예 |  |
| `reservations[].floor` | string | 예 |  |
| `reservations[].when` | string | 예 | 예: 10월 27일(화) 15:00~16:00 |
| `appLink` | string | 예 | 내용 보기·취소·답장은 앱에서 |

## `leave_prepare` — 휴가 신청 준비

휴가 신청 전 확인 화면(또는 휴가 신청 양식)을 고른 날짜·종류로 채워 여는 앱 링크를 돌려줘요. 서버는 날짜 형식·주말·신청할 수 있는 기간만 확인해요. 남은 연차나 병가 쓴 날 같은 숫자는 돌려주지 않으니, 숫자를 물으면 앱에서 보라고 안내해 주세요. 사유는 링크에 담지 않아요. 신청은 결과의 confirm이 말하는 곳(회사 그룹웨어 또는 앱 확인 시트)에서 사람이 직접 해요. 링크를 여는 것만으로는 아무것도 보내지 않아요.

- 범위: `leave.prepare` · 꺼지는 조건: MCP 전체 끔, navi 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 남은 연차, 올해 병가 쓴 날, 사유(앱에서 직접 골라요), 받는 팀 담당자 이름

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `days` | 목록(최대 30) | 예 | 쓸 날 목록. 날마다 date(YYYY-MM-DD)와 kind(full 하루 · am 오전 반차 · pm 오후 반차). 반차인데 오전·오후를 모르면 먼저 사람에게 물어요 |
| `days[].date` | string | 예 | YYYY-MM-DD |
| `days[].kind` | 정해진 값(3개) | 예 | full: 하루 · am: 오전 반차 · pm: 오후 반차. 반차인데 오전·오후를 모르면 사람에게 먼저 물어요 |
| `type` | 정해진 값(3개) | 예 | 종류: annual(연차) · official(공가) · sick(병가) |

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `type` | 정해진 값(3개) | 예 |  |
| `typeLabel` | string | 예 | 연차 · 공가 · 병가 |
| `days` | 목록(최대 30) | 예 | 양식에 채울 날(날짜 순). 형식·주말·기간을 확인한 날만이에요 |
| `days[].date` | string | 예 | YYYY-MM-DD |
| `days[].kind` | 정해진 값(3개) | 예 |  |
| `days[].label` | string | 예 | 예: 11월 6일(금) 하루 · 11월 5일(목) 오전 반차 |
| `link` | string |  | 앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요 |
| `linkText` | string |  |  |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |
| `confirm` | string | 예 | 사람에게 같이 전할 안내 |

## `pantry_find_similar` — 탕비실 요청 찾기

연결한 사람 층의 탕비실 요청판에서 같은 상품 같아 보이는 열린 품목을 최대 3개(이름·지금 표 수) 돌려줘요. 누가 표를 줬는지는 없어요. 품목마다 [여기에 +1] 앱 링크가 있고, +1은 사람이 앱에서 직접 눌러요. 찾는 품목이 없으면 새 요청 쓰기 앱 링크를 줘요. 링크에는 품목 이름을 담지 않아서 새 요청은 사람이 앱에서 직접 써요. 링크를 여는 것만으로는 아무것도 바뀌지 않아요.

- 범위: `pantry.read` · 꺼지는 조건: MCP 전체 끔, pantry 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 표를 준 사람, 요청을 올린 사람, 찾은 품목 이름(어디에도 남지 않아요), 다른 층 판

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `itemName` | string(최대 60자) | 예 | 찾을 품목 이름(예: 제로콜라) |

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `mock` | boolean | 예 | 시연 데이터인지 |
| `floor` | string | 예 | 찾아본 판의 층(연결한 사람의 층) |
| `items` | 목록(최대 3) | 예 | 같은 상품 같아 보이는 열린 품목(표 많은 순) |
| `items[].name` | string | 예 | 판에 올라간 품목 이름 |
| `items[].votes` | integer(0 이상) | 예 | 지금 표 수 |
| `items[].link` | string | 예 | 앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요 |
| `items[].linkText` | string | 예 |  |
| `newRequest` | object | 예 | 새 요청 쓰기: 판의 요청 쓰기 칸을 빈 채로 열어요(품목 이름은 링크에 없어요) |
| `newRequest.link` | string | 예 | 앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요 |
| `newRequest.linkText` | string | 예 |  |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |
| `confirm` | string | 예 | 사람에게 같이 전할 안내 |

## `rooms_find_equipment` — 장비 대여 확인

그 시간에 이동식 장비를 빌릴 수 있는지(남은 수·전체 수)와 대여 확인 앱 링크를 돌려줘요. 누가 빌렸는지는 없어요. 빌리기는 사람이 링크를 열어 앱 확인 시트에서 한 번 눌러요. 링크를 여는 것만으로는 빌리지 않아요. 빌릴 수 없으면 emptyReason에 까닭이 있어요.

- 범위: `rooms.read` · 꺼지는 조건: MCP 전체 끔, rooms 모듈이 켬이 아님, 이 도구를 따로 끔
- 일부러 내보내지 않는 칸: 빌린 사람, 장비별 대여 일정, 장비 보관 위치

### 입력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `kind` | 정해진 값(6개) | 예 | 정해진 장비 종류 중에서: 빔프로젝터, 노트북, 무선 마이크, 웹캠, 스피커폰, HDMI 젠더 |
| `date` | string | 예 | YYYY-MM-DD |
| `start` | string | 예 | HH:MM |
| `minutes` | integer(15~480) |  | 빌릴 시간(분). 비우면 운영 설정 기본 회의 길이 |

### 출력

| 칸 | 모양 | 꼭 | 설명 |
|---|---|---|---|
| `mock` | boolean | 예 | 시연 데이터인지 |
| `kind` | 정해진 값(6개) | 예 |  |
| `when` | string | 예 | 예: 10월 27일(화) 15:00~16:00 |
| `free` | integer(0 이상) | 예 | 그 시간에 남은 수 |
| `total` | integer(0 이상) | 예 | 전체 수 |
| `link` | string |  | 앱 확인 링크. 본인만 열 수 있고 짧은 시간만 유효해요 |
| `linkText` | string |  |  |
| `emptyReason` | object |  | 결과가 없을 때만: 왜 없는지(message를 그대로 전해요) |
| `emptyReason.code` | string | 예 |  |
| `emptyReason.message` | string | 예 |  |
| `confirm` | string | 예 | 사람에게 같이 전할 안내 |
