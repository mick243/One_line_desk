import { randomUUID } from 'node:crypto';
import type { TeamTodayPeopleResponse, TeamTodayResponse } from '@one-line-desk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeaveAdapter, LeaveRecord } from '../adapters/types';
import { createTestApp, MOCK } from '../testing';
import { pseudonymize } from './pseudonym';

// 오늘 우리 팀 한 줄(11/25 회의 결정). 시험 시계는 2026-10-26(월) 9:00이에요.
// 개발팀: 도윤(나)·서준·하은·주원 4명. 재무팀은 2명이라 이름을 펼치지 않아요.

const SEOJUN = 'mock|emp-006';
const HAEUN = 'mock|emp-007';
const JUWON = 'mock|emp-015';
const CANARY = 'SICKCANARY 독감';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** 근태 기록에 사유·종류 칸이 섞여 와도 옮기지 않는지 보려고 덧붙여요. 부른 횟수도 세요. */
function counting(inner: LeaveAdapter, calls: { n: number }): LeaveAdapter {
  return {
    capabilities: inner.capabilities,
    connected: inner.connected,
    recordUses: (p, uses) => inner.recordUses(p, uses),
    async leaveOf(p) {
      calls.n += 1;
      const r = await inner.leaveOf(p);
      return r ? ({ ...r, uses: r.uses.map((u) => ({ ...u, reason: CANARY, typeLabel: '병가' })) } as LeaveRecord) : r;
    },
  };
}

async function setup() {
  const t = await createTestApp();
  opened.push(t);
  await t.modules.find((m) => m.kind === 'navi')!.seed!();
  await t.ctx.ops.setFlag('ops-test', 'teamSchedule', true);
  const leave = t.ctx.adapters.leave;
  await leave.recordUses({ idpSubject: SEOJUN, email: 'seojun@corp.example' }, [{ date: '2026-10-26', kind: 'full', type: 'sick' }]);
  await leave.recordUses({ idpSubject: HAEUN, email: 'haeun@corp.example' }, [{ date: '2026-10-26', kind: 'half', half: 'pm' }]);
  await leave.recordUses({ idpSubject: JUWON, email: 'juwon@corp.example' }, [{ date: '2026-10-27', kind: 'full' }]);
  await leave.recordUses({ idpSubject: MOCK.dev, email: 'doyun@corp.example' }, [{ date: '2026-10-26', kind: 'full' }]);
  const calls = { n: 0 };
  t.ctx.adapters.leave = counting(leave, calls);
  return { t, calls };
}

const accessRows = async (t: TestApp, action: string) =>
  (
    await t.db.query<{ pseudonym_id: string; subject_refs: string[] }>('select pseudonym_id, subject_refs from access_log where action = $1 order by id', [
      action,
    ])
  ).rows;

describe('[11/25] 오늘 우리 팀 한 줄', () => {
  it('홈에는 수만 와요(나 빼고). 이름·종류·사유는 없고, 수를 보여 준 날마다 한 번 접속기록이 남아요', async () => {
    const { t, calls } = await setup();
    const juwon = await t.loginAs(JUWON);
    expect(
      (
        await juwon.call('POST', '/api/navi/away', {
          kind: 'outside',
          start: '2026-10-26T14:00:00+09:00',
          end: '2026-10-26T18:00:00+09:00',
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(200);

    const doyun = await t.loginAs(MOCK.dev);
    const res = await doyun.call('GET', '/api/home/team-today');
    expect(res.status).toBe(200);
    expect(res.body as TeamTodayResponse).toEqual({ enabled: true, team: '개발팀', leave: 2, away: 1, small: false, leaveConnected: true });
    const raw = JSON.stringify(res.body);
    for (const word of ['서준', '하은', '주원', CANARY, '병가', 'sick']) expect(raw).not.toContain(word);

    // 다시 열어도 근태 시스템을 다시 부르지 않고(5분 캐시), 접속기록도 하루 한 번이에요.
    const first = calls.n;
    await doyun.call('GET', '/api/home/team-today');
    expect(calls.n).toBe(first);
    const rows = await accessRows(t, 'team.headcount');
    expect(rows).toHaveLength(1);
    const secret = t.ctx.config.pseudonymSecret;
    expect(rows[0]!.subject_refs.sort()).toEqual([SEOJUN, HAEUN, JUWON].map((s) => `person:${pseudonymize(secret, s)}`).sort());
  });

  it('[누구인지 보기]를 눌러야 이름과 하루/오전/오후·자리비움이 오고, 회의·종류·사유는 없어요. 그때 team.schedule 접속기록이 남아요', async () => {
    const { t } = await setup();
    const doyun = await t.loginAs(MOCK.dev);
    expect(await accessRows(t, 'team.schedule')).toHaveLength(0);
    const res = await doyun.call('GET', '/api/home/team-today/people');
    expect(res.status).toBe(200);
    const body = res.body as TeamTodayPeopleResponse;
    expect(body.entries.map((e) => [e.name, e.what, e.what === 'leave' ? e.part : e.away])).toEqual([
      ['가상 직원 서준', 'leave', 'full'],
      ['가상 직원 하은', 'leave', 'pm'],
    ]);
    expect(JSON.stringify(body)).not.toContain(CANARY);
    expect(JSON.stringify(body)).not.toMatch(/sick|병가|meeting/);
    expect(await accessRows(t, 'team.schedule')).toHaveLength(1);
  });

  it('나 포함 3명 이하 팀은 수도 이름도 보여 주지 않아요(2명 팀은 "1명"만으로 누구인지 드러나요). 접속기록도 없어요', async () => {
    const { t } = await setup();
    const haneul = await t.loginAs(MOCK.staff); // 재무팀 2명
    const today = (await haneul.call('GET', '/api/home/team-today')).body as TeamTodayResponse;
    expect(today).toEqual({ enabled: false, team: '재무팀', leave: 0, away: 0, small: true, leaveConnected: true });
    expect(await accessRows(t, 'team.headcount')).toHaveLength(0);
    const people = await haneul.call('GET', '/api/home/team-today/people');
    expect(people.status).toBe(409);
    expect(await accessRows(t, 'team.schedule')).toHaveLength(0);
  });

  it('같은 팀 일정 스위치가 꺼져 있으면 근태를 읽지 않고 꺼짐만 돌려줘요. 펼치기는 409예요', async () => {
    const { t, calls } = await setup();
    await t.ctx.ops.setFlag('ops-test', 'teamSchedule', false);
    const doyun = await t.loginAs(MOCK.dev);
    expect(((await doyun.call('GET', '/api/home/team-today')).body as TeamTodayResponse).enabled).toBe(false);
    expect((await doyun.call('GET', '/api/home/team-today/people')).status).toBe(409);
    expect(calls.n).toBe(0);
    expect(await accessRows(t, 'team.headcount')).toHaveLength(0);
  });

  it('로그인하지 않으면 401이에요', async () => {
    const { t } = await setup();
    expect((await t.app.inject({ method: 'GET', url: '/api/home/team-today' })).statusCode).toBe(401);
  });
});
