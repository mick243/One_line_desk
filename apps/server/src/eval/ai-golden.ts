// 정답률 표의 정답 단 문장(11/5 시험, AI 보완 1번, PRD F1·ADR-02 경계 문장 골든셋).
// 개발자가 지은 가상 문장이에요. 직원이 쓴 글·사람 자료는 없어요.
// 정답은 "제대로 된 데스크라면 이렇게 나눠야 한다"예요. 지금 규칙이 하는 대로 적지 않아요(그래야 규칙의 빈틈이 보여요).
// 정답 꼴:
// - home(홈 채팅): 'mine' | 'team-schedule' | 'unknown' | 'move:<rooms|navi|notices|board|away>'
// - room-chat(회의실 채팅): '<intent>' 또는 장비가 나오면 '<intent>:<장비·장비>'(LOAN_KINDS 순서)
// - router(기능 나누기): 'navi' | 'notices' | 'rooms' | 'pantry' | 'unknown'
// 되돌릴 기준: #30 머지 상태(이 파일째 지워요).

export type EvalTask = 'home' | 'room-chat' | 'router';

export interface GoldenCase {
  task: EvalTask;
  text: string;
  expect: string;
  /** 왜 이 정답인지(경계 문장일 때) */
  why?: string;
}

export const GOLDEN: readonly GoldenCase[] = [
  // ── 홈 채팅 ──
  { task: 'home', text: '이번 주 내 일정 알려 줘', expect: 'mine' },
  { task: 'home', text: '내일 회의 있어?', expect: 'mine' },
  { task: 'home', text: '내가 보낸 문의 답장 왔어?', expect: 'mine' },
  { task: 'home', text: '휴가 신청한 거 어떻게 됐어?', expect: 'mine' },
  { task: 'home', text: '우리 팀에 들어온 문의 있어?', expect: 'mine' },
  { task: 'home', text: '다음 주에 나 뭐 있지?', expect: 'mine' },
  { task: 'home', text: '내일 3시에 6명 회의실 잡아 줘', expect: 'move:rooms' },
  { task: 'home', text: '빔프로젝터 빌리고 싶어', expect: 'move:rooms' },
  { task: 'home', text: '법인카드 잃어버렸는데 어디에 말해?', expect: 'move:navi' },
  { task: 'home', text: '다음 주 금요일 연차 쓰고 싶어', expect: 'move:navi' },
  { task: 'home', text: '탕비실에 제로콜라 좀 넣어 줘', expect: 'move:board' },
  { task: 'home', text: '연말 행사 공지 어디 있어?', expect: 'move:notices' },
  { task: 'home', text: '오늘 우리 팀 누가 없어?', expect: 'team-schedule' },
  { task: 'home', text: '팀장님 오늘 회의 있어?', expect: 'team-schedule' },
  { task: 'home', text: '나 오후에 외근이야', expect: 'move:away' },
  { task: 'home', text: '점심 메뉴 추천해 줘', expect: 'unknown' },
  { task: 'home', text: '회의실 TV가 안 켜져요', expect: 'move:navi', why: '고장 신고라 담당 팀에 알려야 해요. 내 예약을 묻는 말이 아니에요' },
  { task: 'home', text: '커피머신이 고장 났어요', expect: 'move:navi', why: '탕비실 요청이 아니라 고장 신고예요' },
  { task: 'home', text: '요즘 노트북이 너무 느려요', expect: 'move:navi', why: '장비 대여가 아니라 IT 문의예요' },
  { task: 'home', text: '신입인데 첫 주에 뭘 해야 해?', expect: 'move:navi', why: '첫 2주 안내는 문의하기에 있어요' },
  { task: 'home', text: '내 자리 모니터 하나 더 받을 수 있어?', expect: 'move:navi', why: '"내"가 있어도 내 일정을 묻는 말이 아니에요' },
  { task: 'home', text: '이번 주 금요일 팀 회식 장소 공지 났어?', expect: 'move:notices' },
  // 11/5 홈 지시문 보강 뒤에 더한 처음 보는 문장(지시문 예문과 겹치지 않게 골랐어요)
  { task: 'home', text: '프린터에서 종이가 계속 걸려요', expect: 'move:navi', why: '고장 신고예요' },
  { task: 'home', text: '사무실 에어컨이 안 나와요', expect: 'move:navi', why: '시설 고장 신고예요' },
  { task: 'home', text: '모니터 케이블이 하나 더 필요해요', expect: 'move:navi', why: '사무 비품 요청이에요' },

  // ── 회의실 채팅 ──
  { task: 'room-chat', text: '내일 3시 6명 회의실 잡아 줘', expect: 'reserve' },
  { task: 'room-chat', text: '지금 빈 회의실 있어?', expect: 'overview' },
  { task: 'room-chat', text: '빔프로젝터 빌려 줘', expect: 'rent:빔프로젝터' },
  { task: 'room-chat', text: '내 예약 보여 줘', expect: 'my' },
  { task: 'room-chat', text: '3A 회의실에 화상회의 장비 있어?', expect: 'equipment' },
  { task: 'room-chat', text: '오후 4시 예약 취소해 줘', expect: 'cancel' },
  { task: 'room-chat', text: '노트북 몇 대 남았어?', expect: 'equipment:노트북' },
  { task: 'room-chat', text: '다음 회의에 마이크도 빌려 줘', expect: 'rent:무선 마이크' },
  { task: 'room-chat', text: '오늘 회의실 현황 보여 줘', expect: 'overview' },
  { task: 'room-chat', text: '회의실 쓰는 법 알려 줘', expect: 'help' },
  { task: 'room-chat', text: '빔프로젝터 반납할게', expect: 'cancel:빔프로젝터' },
  { task: 'room-chat', text: '다섯 명이서 회의할 곳 필요해', expect: 'reserve', why: '"회의실"이라는 낱말이 없어도 회의할 곳을 찾는 말이에요' },
  { task: 'room-chat', text: '발표 연습할 방 하나 잡아 줄래', expect: 'reserve' },
  { task: 'room-chat', text: '빔프로젝터 남았어?', expect: 'equipment:빔프로젝터', why: '11/5 모델이 "프로젝터"로 줄여 보내 해석이 실패하던 문장이에요' },

  // ── 기능 나누기(/ask) ──
  { task: 'router', text: '법인카드 분실 신고는 어디서 해?', expect: 'navi' },
  { task: 'router', text: '다음 주 화요일 2시 8명 회의실', expect: 'rooms' },
  { task: 'router', text: '탕비실에 녹차 티백 채워 주세요', expect: 'pantry' },
  { task: 'router', text: '연말정산 공지 찾아 줘', expect: 'notices' },
  { task: 'router', text: '회의실 TV가 안 켜져요', expect: 'navi', why: 'ADR-02 경계 문장. 회의실 예약이 아니라 고장 신고예요' },
  { task: 'router', text: '커피머신 고장 났어요', expect: 'navi', why: '탕비실 요청이 아니라 고장 신고예요' },
  { task: 'router', text: '명함 새로 만들고 싶어요', expect: 'navi' },
  { task: 'router', text: '오늘 점심 뭐 먹지', expect: 'unknown' },
  { task: 'router', text: '와이파이가 안 잡혀요', expect: 'navi' },
  { task: 'router', text: '내일 오전 대회의실 비어 있어?', expect: 'rooms' },
  { task: 'router', text: '회식 장소 공지 났어?', expect: 'notices' },
  { task: 'router', text: '택배 보관함 어디 있어요?', expect: 'navi' },
  { task: 'router', text: '모니터 받침대 신청하고 싶어요', expect: 'navi', why: '탕비실 비품이 아니라 사무 비품 신청이에요' },
];
