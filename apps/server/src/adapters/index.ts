import type { ServerConfig } from '../config';
import type { Db } from '../core/db';
import { KeycloakAdapter } from './keycloak';
import { MockEmployees } from './mock/employees';
import { MockGroupwareCalendar, MockMessenger } from './mock/groupware';
import { MockLeave } from './mock/leave';
import { OffCalendar, OffLeave, OffMessenger } from './off';
import { SlackMessenger } from './slack';
import type { AdapterCapabilities, CalendarAdapter, DirectoryAdapter, IdpAdapter, LeaveAdapter, MessengerAdapter } from './types';

export interface Adapters {
  idp: IdpAdapter;
  directory: DirectoryAdapter;
  /** 그룹웨어 캘린더·메신저. 없으면 앱이 DB에 모의 어댑터를 만들어요(buildApp). */
  calendar?: CalendarAdapter;
  messenger?: MessengerAdapter;
  /** 인사 근태(본인 연차). 없으면 시연은 가상 연차 자료, 운영은 "연결 안 함"이에요(ADR-18). */
  leave?: LeaveAdapter;
  /** 띠에 보여 줄 목록. 회의실 장부·공지·분장표·카탈로그 어댑터가 생기면 여기에 더해요. */
  all(): AdapterCapabilities[];
}

/** 설정대로 어댑터를 골라요. 임시 IdP(Keycloak)를 켜면 로그인·직원 명단이 그쪽으로 가요. Slack 토큰이 있으면 실제 Slack이에요. */
export function createAdapters(config: ServerConfig): Adapters {
  const base: Adapters = config.idp.kind === 'keycloak' ? keycloakAdapters(new KeycloakAdapter(config.idp)) : createMockAdapters();
  if (!config.slackBotToken) return base;
  const messenger = new SlackMessenger(config.slackBotToken);
  return { ...base, messenger, all: () => [...base.all(), messenger.capabilities] };
}

/**
 * 앱이 쓰는 어댑터: 캘린더·메신저·인사 근태가 없으면 시연은 모의 어댑터를, 운영은 "연결 안 함" 어댑터를 채워요(그래서 늘 있어요).
 * 운영에서는 모의 어댑터가 0개예요(L-15). 연결 안 함 어댑터는 보내기를 실패로, 읽기를 "없음"으로 돌려줘요.
 */
export type ResolvedAdapters = Adapters & { calendar: CalendarAdapter; messenger: MessengerAdapter; leave: LeaveAdapter };

export function withOutboundAdapters(a: Adapters, db: Db, now: () => number, allowMock = true): ResolvedAdapters {
  const calendar = a.calendar ?? (allowMock ? new MockGroupwareCalendar(db, now) : new OffCalendar());
  const messenger = a.messenger ?? (allowMock ? new MockMessenger(db, now) : new OffMessenger());
  const leave = a.leave ?? (allowMock ? new MockLeave() : new OffLeave());
  return {
    ...a,
    calendar,
    messenger,
    leave,
    all: () => [
      ...a.all(),
      ...(a.calendar ? [] : [calendar.capabilities]),
      ...(a.messenger ? [] : [messenger.capabilities]),
      ...(a.leave ? [] : [leave.capabilities]),
    ],
  };
}

function keycloakAdapters(kc: KeycloakAdapter): Adapters {
  return { idp: kc, directory: kc, all: () => [kc.capabilities] };
}

export function createMockAdapters(): Adapters & { employees: MockEmployees } {
  const employees = new MockEmployees();
  return {
    idp: employees,
    directory: employees,
    employees,
    all: () => [employees.capabilities],
  };
}
