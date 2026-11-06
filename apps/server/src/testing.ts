import { expect } from 'vitest';
import { createMockAdapters } from './adapters';
import { type BuildOptions, buildApp } from './app';
import { loadConfig } from './config';
import { createTestDb } from './core/db/test-db';

// 경로 시험 도우미. 모듈 시험도 이걸 써요: 새 PGlite + 모의 IdP + 시계를 돌릴 수 있는 앱.

export const MOCK = {
  staff: 'mock|emp-001', // 가상 직원 하늘, 재무팀, 3층(분장표 주인)
  dev: 'mock|emp-002', // 가상 직원 도윤, 개발팀, 5층
  facilities: 'mock|emp-003', // 가상 총무 서연, 총무팀, 2층
  hr: 'mock|emp-004', // 가상 인사 지후, 인사팀, 2층
  operator: 'mock|emp-005', // 가상 운영자 민준, 정보보안팀, 4층
  barista: 'mock|emp-017', // 가상 바리스타 하준, 카페팀, 1층(역할 cafe, 11/6 ADR-29)
  devMember: 'mock|emp-006', // 가상 직원 서준, 개발팀, 5층(팀장 도윤의 팀원, 11/6 가상 그룹웨어 결재선)
} as const;

export async function createTestApp(
  opts: Partial<Omit<BuildOptions, 'config'>> & {
    start?: number;
    /**
     * 앱 안 휴가 결재(DESK_LEAVE_IN_APP, ADR-24). 11/6 A안 전에 쓴 시험은 그 흐름(휴가 요청·인사팀 승인)을 시험해서 켠 채로 돌아요.
     * A안(그룹웨어로 넘기기, 운영 기본) 시험은 false를 넘겨요.
     */
    leaveInApp?: boolean;
  } = {},
) {
  let clock = opts.start ?? Date.parse('2026-10-26T09:00:00+09:00');
  const db = opts.db ?? (await createTestDb());
  const adapters = createMockAdapters();
  // 보관 회차는 시험이 runRetention()으로 직접 불러요. 켜 두면 듣기(listen) 전까지 받을 준비가 503이에요.
  const { leaveInApp = true, ...rest } = opts;
  const built = await buildApp({
    config: { ...loadConfig({}), databaseUrl: undefined, leaveInApp },
    db,
    adapters,
    now: () => clock,
    seed: false,
    retentionTimer: false,
    ...rest,
  });
  return {
    ...built,
    db,
    adapters,
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    async close() {
      await built.app.close();
      if (!rest.db) await db.close();
    },
    async loginAs(idpSubject: string) {
      const res = await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: { idpSubject } });
      expect(res.statusCode).toBe(200);
      const setCookie = String(res.headers['set-cookie']);
      const cookie = setCookie.split(';')[0]!;
      const me = (await built.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
      const csrf = me.csrfToken as string;
      return {
        cookie,
        setCookie,
        csrf,
        me,
        /** 로그인한 사람으로 API를 불러요. 쓰기 요청에는 CSRF 토큰을 붙여요. */
        async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
          const res = await built.app.inject({
            method,
            url,
            headers: { cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) },
            ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
          });
          return { status: res.statusCode, body: res.body ? res.json() : undefined };
        },
      };
    },
  };
}
