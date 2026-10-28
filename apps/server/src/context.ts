import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedAdapters } from './adapters';
import type { AdapterCapabilities } from './adapters/types';
import type { ServerConfig } from './config';
import type { AiGateway } from './core/ai/gateway';
import type { AccessRecorder } from './core/access-record';
import type { AuditLog } from './core/audit';
import type { Db } from './core/db';
import type { FixedActions } from './core/fixed-action';
import type { Notifier } from './core/notifications';
import type { OpsSettingsStore } from './core/ops-settings';
import type { PlanService } from './core/plans';
import type { RateLimiter } from './core/rate-limit';
import type { Services } from './core/services';
import type { SessionStore } from './core/session';
import type { Role } from '@one-line-desk/shared';

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** 모듈이 받는 공통 바닥. 모듈은 이것과 core/만 써요. */
export interface AppContext {
  config: ServerConfig;
  db: Db;
  /** 로그인·직원 명단·그룹웨어 캘린더·메신저(ADR-05·17) */
  adapters: ResolvedAdapters;
  /** 공통 어댑터와 모듈 어댑터(회의실 장부·분장표·공지 등)를 모두 모은 목록. 실제 데이터인지 판별할 때 써요(ADR-05·15). */
  dataAdapters: () => AdapterCapabilities[];
  sessions: SessionStore;
  audit: AuditLog;
  /** 접속기록(ADR-20). 감사 로그와 따로, 법이 요구하는 접속지·처리한 정보주체를 남겨요. */
  access: AccessRecorder;
  ops: OpsSettingsStore;
  rateLimiter: RateLimiter;
  gateway: AiGateway;
  plans: PlanService;
  fixed: FixedActions;
  /** 앱 안 알림(ADR-16). 쓰기 트랜잭션 안에서 같이 넣어요. */
  notify: Notifier;
  /** 모듈 사이 기능(core/services.ts). 제공하는 모듈이 팩토리에서 채워요. */
  services: Services;
  guards: {
    /** 로그인·재직 재확인·CSRF를 지나면 req.deskUser가 채워져요. */
    user: PreHandler;
    /** user를 지난 뒤 역할까지 확인해요. */
    role(role: Role): PreHandler;
  };
  now: () => number;
}
