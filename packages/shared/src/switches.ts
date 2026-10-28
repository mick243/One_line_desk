import { MODULES, type ModuleKind } from './kinds';

// 끄기 스위치(ADR-12, R4). 운영자만 바꾸고, 바꿀 때마다 감사 로그에 남겨요.
export type ModuleSwitch = 'on' | 'link' | 'off';

export interface OpsSettings {
  modules: Record<ModuleKind, ModuleSwitch>;
  /** 끄면 회의실 카드 주 버튼과 MCP 링크가 그룹웨어 링크로 바뀌어요. */
  roomsWrite: boolean;
  /** MCP 전체 스위치(M5). 해당 모듈이 켬일 때만 그 도구가 나와요. */
  mcp: boolean;
  /** 채팅 자동 실행(ADR-19). 끄면 채팅도 카드와 확인 시트로만 예약·대여해요. */
  autoActions: boolean;
  /** 이번 2주는 고정이에요(M6). */
  noticeSummary: false;
  s5Mode: 'list-only';
  /** "링크만"일 때 보내는 그룹웨어 화면 주소. 회사 그룹웨어가 정해지면 바꿔요(사용자 확인 1). */
  links: Record<ModuleKind, string>;
  values: {
    /** 아래 값은 아직 정하지 않은 임시값이에요. 운영 설정에서 바꿔요. */
    defaultMeetingMinutes: number;
    proposalTtlSeconds: number;
    planTtlSeconds: number;
    employmentRecheckSeconds: number;
    rateLimitPerMinute: number;
  };
}

export const DEFAULT_OPS_SETTINGS: OpsSettings = {
  modules: { navi: 'on', notices: 'on', rooms: 'on', pantry: 'on' },
  roomsWrite: true,
  mcp: false,
  autoActions: true,
  noticeSummary: false,
  s5Mode: 'list-only',
  links: {
    navi: 'https://groupware.example.com/helpdesk',
    notices: 'https://groupware.example.com/board',
    rooms: 'https://groupware.example.com/resources',
    pantry: 'https://groupware.example.com/supplies',
  },
  values: {
    defaultMeetingMinutes: 60,
    proposalTtlSeconds: 600,
    planTtlSeconds: 600,
    // 퇴사 시 늦어도 10분 안에 끊겨야 해서 10분보다 짧게 둬요(ADR-13).
    employmentRecheckSeconds: 300,
    rateLimitPerMinute: 20,
  },
};

/** 출시(운영) 기본값(CD-14): 회의실 쓰기·MCP·채팅 자동 실행은 끈 채로 시작해요. 운영자가 바꾸면 운영 설정 표에 남아요. */
export const LAUNCH_OPS_SETTINGS: OpsSettings = { ...DEFAULT_OPS_SETTINGS, roomsWrite: false, mcp: false, autoActions: false };

/** "같이 채워요 단독" 모드 = navi·notices·rooms 모두 끔. 묻기 탭을 숨기고 같이 채워요 탭이 첫 화면이에요. */
export function isPantryStandalone(settings: OpsSettings): boolean {
  return (['navi', 'notices', 'rooms'] as const).every((m) => settings.modules[m] === 'off');
}

/** 회의실 쓰기(예약·취소·참석자 초대)가 켜져 있는지. 회의실이 `켬`이고 회의실 쓰기가 켜졌을 때만이에요. */
export function roomsWriteOn(settings: OpsSettings): boolean {
  return settings.modules.rooms === 'on' && settings.roomsWrite;
}

/** 라우터 후보에 남는 종류. 끔인 종류는 빠지고, 링크만은 남아서 링크 카드를 받아요. */
export function routableModules(settings: OpsSettings): ModuleKind[] {
  return MODULES.filter((m) => settings.modules[m] !== 'off');
}
