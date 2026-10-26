import type { Equipment } from '@one-line-desk/shared';

// 시연용 모의 회의실 장부 원본(가상 자료, 등급 0). 실제 회사·사람·회의가 아니에요.
// 실제 장부처럼 예약자 이름과 회의 제목이 들어 있어요. ledger-adapter.ts가 이 두 칸을 버리고 가명 예약으로 넣어요(ADR-06).

export interface LedgerSourceRoom {
  id: string;
  name: string;
  floor: string;
  capacity: number;
  equipment: Equipment[];
  /** 화면에 보여 줄 설비 설명 */
  facilities: string[];
  /** 방 사진 주소. 시연은 웹이 내주는 그림(apps/web/public/rooms)이에요. */
  photoUrl: string;
}

export interface LedgerSourceBooking {
  /** 장부 안 예약 번호(사람을 가리키지 않아요) */
  ref: string;
  roomId: string;
  /** 장부를 가져오는 날 기준 며칠 뒤인지 */
  dayOffset: number;
  /** HH:MM(한국 시각) */
  start: string;
  end: string;
  /** 원본에만 있는 칸. 어댑터 밖으로 나가지 않아요. */
  organizer: string;
  title: string;
}

export const LEDGER_ROOMS: LedgerSourceRoom[] = [
  {
    id: 'r-2a',
    name: '회의실 2A',
    floor: '2층',
    capacity: 4,
    equipment: ['화면'],
    facilities: ['TV 모니터 55인치', 'HDMI 케이블', '창문'],
    photoUrl: '/rooms/r-2a.svg',
  },
  {
    id: 'r-2b',
    name: '회의실 2B',
    floor: '2층',
    capacity: 8,
    equipment: ['화면', '화상회의'],
    facilities: ['빔프로젝터', '화상회의 카메라·스피커', 'HDMI·USB-C 케이블'],
    photoUrl: '/rooms/r-2b.svg',
  },
  { id: 'r-3a', name: '회의실 3A', floor: '3층', capacity: 4, equipment: [], facilities: ['창문', '콘센트 4개'], photoUrl: '/rooms/r-3a.svg' },
  {
    id: 'r-3b',
    name: '회의실 3B',
    floor: '3층',
    capacity: 6,
    equipment: ['화면'],
    facilities: ['TV 모니터 65인치', 'HDMI·USB-C 케이블', '콘센트 6개'],
    photoUrl: '/rooms/r-3b.svg',
  },
  {
    id: 'r-3c',
    name: '회의실 3C',
    floor: '3층',
    capacity: 10,
    equipment: ['화면', '화상회의', '화이트보드'],
    facilities: ['빔프로젝터', '화상회의 카메라·스피커', '화이트보드', '무선 화면 공유'],
    photoUrl: '/rooms/r-3c.svg',
  },
  {
    id: 'r-4a',
    name: '회의실 4A',
    floor: '4층',
    capacity: 6,
    equipment: ['화이트보드'],
    facilities: ['벽면 화이트보드', '마커·지우개', '창문'],
    photoUrl: '/rooms/r-4a.svg',
  },
  {
    id: 'r-4b',
    name: '회의실 4B',
    floor: '4층',
    capacity: 12,
    equipment: ['화면', '화상회의'],
    facilities: ['빔프로젝터', '화상회의 카메라·스피커', '마이크 2개'],
    photoUrl: '/rooms/r-4b.svg',
  },
  {
    id: 'r-5a',
    name: '회의실 5A',
    floor: '5층',
    capacity: 4,
    equipment: ['화상회의'],
    facilities: ['화상회의 카메라·스피커', 'TV 모니터 43인치', '방음'],
    photoUrl: '/rooms/r-5a.svg',
  },
  {
    id: 'r-5b',
    name: '회의실 5B',
    floor: '5층',
    capacity: 8,
    equipment: ['화면', '화이트보드'],
    facilities: ['TV 모니터 75인치', '화이트보드', '무선 화면 공유'],
    photoUrl: '/rooms/r-5b.svg',
  },
  {
    id: 'r-5c',
    name: '대회의실 5C',
    floor: '5층',
    capacity: 20,
    equipment: ['화면', '화상회의', '화이트보드'],
    facilities: ['빔프로젝터 2대', '화상회의 카메라·스피커', '무선 마이크 4개', '화이트보드', '강연대'],
    photoUrl: '/rooms/r-5c.svg',
  },
];

export const LEDGER_BOOKINGS: LedgerSourceBooking[] = [
  { ref: 'b-01', roomId: 'r-3c', dayOffset: 0, start: '10:00', end: '11:00', organizer: '가상 예약자 하람', title: '가상 회의: 주간 업무 점검' },
  { ref: 'b-02', roomId: 'r-2a', dayOffset: 0, start: '14:00', end: '15:00', organizer: '가상 예약자 이든', title: '가상 회의: 신입 면담' },
  { ref: 'b-03', roomId: 'r-3b', dayOffset: 1, start: '15:00', end: '16:00', organizer: '가상 예약자 하람', title: '가상 회의: 분기 예산 검토' },
  { ref: 'b-04', roomId: 'r-2b', dayOffset: 1, start: '15:00', end: '17:00', organizer: '가상 예약자 소율', title: '가상 회의: 채용 면접' },
  { ref: 'b-05', roomId: 'r-4b', dayOffset: 1, start: '14:00', end: '15:30', organizer: '가상 예약자 이든', title: '가상 회의: 고객사 화상 미팅' },
  { ref: 'b-06', roomId: 'r-5c', dayOffset: 1, start: '09:00', end: '10:00', organizer: '가상 예약자 다온', title: '가상 회의: 전체 조회' },
  { ref: 'b-07', roomId: 'r-4a', dayOffset: 1, start: '10:00', end: '12:00', organizer: '가상 예약자 소율', title: '가상 회의: 기획 워크숍' },
  { ref: 'b-08', roomId: 'r-5b', dayOffset: 2, start: '13:00', end: '14:00', organizer: '가상 예약자 다온', title: '가상 회의: 디자인 리뷰' },
];
