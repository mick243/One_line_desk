import type pg from 'pg';
import type { Adapters } from './adapters';
import type { ServerConfig } from './config';
import type { AiGateway } from './core/ai-gateway';
import type { AuditLog } from './core/audit';
import type { OpsSettingsStore } from './core/ops-settings';
import type { RateLimiter } from './core/rate-limit';
import type { SessionStore } from './core/session';

export interface AppContext {
  config: ServerConfig;
  adapters: Adapters;
  sessions: SessionStore;
  audit: AuditLog;
  ops: OpsSettingsStore;
  rateLimiter: RateLimiter;
  gateway: AiGateway;
  pool: pg.Pool | undefined;
  now: () => number;
}
