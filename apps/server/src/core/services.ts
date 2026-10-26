import type { NoticeHit, RoomQuery, RoomSearchResult } from '@one-line-desk/shared';
import type { DeskUser } from './user';

// 모듈 사이에 필요한 기능은 이 인터페이스로만 주고받아요(ADR-01 모듈 경계).
// 제공하는 모듈이 자기 팩토리에서 ctx.services에 넣고, 쓰는 쪽(MCP 등)은 여기서 꺼내요.

export interface RoomsService {
  /** 빈 방 후보 최대 3개와 대안. 읽기만 하고 예약자·회의 제목은 없어요(ADR-06·14). */
  findFree(query: RoomQuery): Promise<RoomSearchResult>;
  /** 후보 하나로 앱 확인 링크용 제안 토큰을 만들어요(M3). */
  proposeReservation(user: Pick<DeskUser, 'pseudonymId'>, candidate: { roomId: string; start: string; end: string; query: RoomQuery }): string;
}

export interface NoticesService {
  /** 허용 게시판의 제목·게시일·원문 링크만(ADR-14). LLM을 부르지 않아요. */
  search(query: string, limit: number): Promise<{ mock: boolean; hits: NoticeHit[] }>;
}

export interface NaviService {
  /** 분장표에 행을 가진 부서. 분장표 주인 역할 계산에 써요(R17). */
  ownerDepartments(): Promise<Set<string>>;
}

export interface McpService {
  /** 모든 기기 로그아웃·퇴사 확인 때 그 사람의 MCP 승인(갱신 토큰)을 모두 지워요(ADR-13·15). 지운 수를 돌려줘요. */
  revokeAll(pseudonymId: string): Promise<number>;
  /** 지금 MCP를 켤 수 있는지. 실제 데이터인데 보안팀이 승인한 앱이 없으면 거짓이에요(ADR-12·15). */
  canEnable(): Promise<boolean>;
}

export interface Services {
  rooms?: RoomsService;
  notices?: NoticesService;
  navi?: NaviService;
  mcp?: McpService;
}
