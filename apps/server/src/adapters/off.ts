import type { AdapterCapabilities, CalendarAdapter, LeaveAdapter, LeaveRecord, MessengerAdapter } from './types';

// 운영에서 실제 그룹웨어 캘린더·Slack을 아직 붙이지 않았을 때 쓰는 "연결 안 함" 어댑터(L-15).
// 모의 표에 쓰지 않고, 보내기는 실패로 돌려줘요. 초대 결과 카드에는 "못 보냄"으로 셀 수 있어요.

export class OffCalendar implements CalendarAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'calendar-off', label: '그룹웨어 캘린더(연결 안 함)', mock: false };
  async upsertEvent(): Promise<void> {
    throw new Error('그룹웨어 캘린더가 연결되지 않았어요');
  }
  async cancelEvent(): Promise<void> {
    throw new Error('그룹웨어 캘린더가 연결되지 않았어요');
  }
}

export class OffMessenger implements MessengerAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'messenger-off', label: 'Slack(연결 안 함)', mock: false };
  async sendDirect(): Promise<'sent' | 'not-found'> {
    throw new Error('Slack이 연결되지 않았어요');
  }
}

/** 인사 근태 시스템을 아직 붙이지 않았을 때예요. 남은 연차 카드는 "그룹웨어 근태 메뉴에서 확인해 주세요"로 안내해요. */
export class OffLeave implements LeaveAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'leave-off', label: '인사 근태(연결 안 함)', mock: false };
  async leaveOf(): Promise<LeaveRecord | null> {
    return null;
  }
}
