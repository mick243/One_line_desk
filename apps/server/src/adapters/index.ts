import type { ServerConfig } from '../config';
import type { Db } from '../core/db';
import { KeycloakAdapter } from './keycloak';
import { MockEmployees } from './mock/employees';
import { MockGroupwareCalendar, MockMessenger } from './mock/groupware';
import { SlackMessenger } from './slack';
import type { AdapterCapabilities, CalendarAdapter, DirectoryAdapter, IdpAdapter, MessengerAdapter } from './types';

export interface Adapters {
  idp: IdpAdapter;
  directory: DirectoryAdapter;
  /** 그룹웨어 캘린더·메신저. 없으면 앱이 DB에 모의 어댑터를 만들어요(buildApp). */
  calendar?: CalendarAdapter;
  messenger?: MessengerAdapter;
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

/** 앱이 쓰는 어댑터: 캘린더·메신저가 없으면 DB에 모의 어댑터를 채워요(그래서 늘 있어요). */
export type ResolvedAdapters = Adapters & { calendar: CalendarAdapter; messenger: MessengerAdapter };

export function withOutboundAdapters(a: Adapters, db: Db, now: () => number): ResolvedAdapters {
  const calendar = a.calendar ?? new MockGroupwareCalendar(db, now);
  const messenger = a.messenger ?? new MockMessenger(db, now);
  return {
    ...a,
    calendar,
    messenger,
    all: () => [...a.all(), ...(a.calendar ? [] : [calendar.capabilities]), ...(a.messenger ? [] : [messenger.capabilities])],
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
