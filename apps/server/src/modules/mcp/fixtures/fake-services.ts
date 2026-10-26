import type { NoticeHit, RoomCandidate, RoomQuery, RoomSearchResult } from '@one-line-desk/shared';
import type { NoticesService, RoomsService } from '../../../core/services';

// MCP 시험용 가짜 회의실·공지 서비스. 다른 에이전트가 만드는 실제 모듈 대신 ctx.services에 넣어요.
// 일부러 예약자 이름·회의 제목·방별 일정·공지 본문 같은 칸을 실어 보내서 MCP 출력에서 빠지는지 봐요.
// 모두 가상 값(등급 0)이에요.

export const CANARY = {
  booker: '가상예약자카나리BK7',
  meetingTitle: '비밀회의제목카나리MT3',
  noticeBody: '공지본문카나리NB5',
  noticeSummary: '공지요약카나리NS9',
} as const;

export function fakeRooms(opts: { mock?: boolean; empty?: boolean } = {}) {
  const calls = { findFree: [] as RoomQuery[], propose: [] as { pseudonymId: string; roomId: string; start: string; end: string }[] };
  const leak = { bookerName: CANARY.booker, meetingTitle: CANARY.meetingTitle, schedule: [{ booker: CANARY.booker, title: CANARY.meetingTitle }] };
  const candidate = (n: number, hour: string): RoomCandidate =>
    ({
      roomId: `room-${n}`,
      roomName: `가상 회의실 ${n}`,
      floor: '3층',
      start: `2026-10-27T${hour}:00+09:00`,
      end: `2026-10-27T${String(Number(hour.slice(0, 2)) + 1).padStart(2, '0')}:${hour.slice(3)}:00+09:00`,
      matched: ['인원 6명 이상', '화면'],
      ...leak,
    }) as RoomCandidate;

  const service: RoomsService = {
    async findFree(query) {
      calls.findFree.push(query);
      return {
        checkedAt: '2026-10-26T09:00:00+09:00',
        mock: opts.mock ?? true,
        candidates: opts.empty ? [] : [candidate(1, '15:00'), candidate(2, '15:00'), candidate(3, '15:00'), candidate(4, '15:00')],
        alternatives: opts.empty ? [candidate(5, '16:00'), candidate(6, '17:00'), candidate(7, '18:00')] : [],
        ...leak,
      } as RoomSearchResult;
    },
    proposeReservation(user, c) {
      calls.propose.push({ pseudonymId: user.pseudonymId, roomId: c.roomId, start: c.start, end: c.end });
      return `fakeProposal${calls.propose.length}.sig`;
    },
  };
  return { service, calls };
}

export function fakeNotices(opts: { mock?: boolean } = {}) {
  const calls: { query: string; limit: number }[] = [];
  const service: NoticesService = {
    async search(query, limit) {
      calls.push({ query, limit });
      const hits = [
        {
          id: 'n-1',
          title: '\u0007연말정산 안내\u202E (가상)',
          postedOn: '2026-10-20',
          url: 'https://groupware.example.com/board/1',
          board: '인사',
          body: CANARY.noticeBody,
          summary: CANARY.noticeSummary,
        },
        { id: 'n-2', title: '가'.repeat(300), postedOn: '어제', url: 'https://groupware.example.com/board/2', board: '총무', body: CANARY.noticeBody },
        { id: 'n-3', title: '나쁜 링크 공지', postedOn: '2026-10-21', url: 'javascript:alert(1)', board: '총무' },
      ] as NoticeHit[];
      return { mock: opts.mock ?? true, hits };
    },
  };
  return { service, calls };
}
