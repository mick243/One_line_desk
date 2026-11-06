import {
  type AskResponse,
  type NewNoticesResponse,
  NOTICE_AUDIENCE_TEXT,
  type NoticeAudienceDecisionResponse,
  type NoticeAudienceListResponse,
  type NotificationsResponse,
} from '@one-line-desk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGateway, type LlmProvider, type ProviderResult, type StructuredRequest } from '../../core/ai/gateway';
import { pseudonymize } from '../../core/pseudonym';
import type { NoticeCopy } from '../../core/services';
import { createTestApp, MOCK } from '../../testing';
import { cleanProposal, matchesAudience, modelInput, optionsOf, proposeByRules } from './audience';

// 새 공지 알림 대상(11/6 사용자 요청, ADR-09 개정·ADR-16 보강).
// AI는 공지 글만 보고 대상을 제안하고, 총무가 [알리기]를 눌러야 조건에 맞는 재직자 각자에게 내용 없는 알림이 가요.
// 가상 직원: 개발팀(5층) 도윤(팀장)·서준·하은·주원 / 재무팀(3층) 하늘·수아 / 영업팀(3층) 예준·시우 / 총무팀(2층) 서연(총무) /
// 인사팀(2층) 지후·은우 / 정보보안팀(4층) 민준(운영자)·다인 / 디자인팀(5층) 지우(팀장)·유나 / IT지원팀(4층) 하린 / 카페팀(1층) 하준.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const opened: TestApp[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** 게이트웨이가 공급자에 넘긴 입력을 적어 두고, 정해 둔 답(없으면 결정적 대안)을 돌려주는 시험용 공급자(실제 모델 흉내) */
class RecordingProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly inputs: { purpose: string; input: string; system: string; grade: number }[] = [];
  constructor(private readonly answer?: unknown) {}
  async complete<T>(req: StructuredRequest<T>): Promise<ProviderResult<T>> {
    this.inputs.push({ purpose: req.purpose, input: req.input, system: req.system, grade: req.grade });
    return { output: req.schema.parse(this.answer ?? req.fallback()), inputTokens: 1, outputTokens: 1 };
  }
}

async function setup(o: { provider?: LlmProvider } = {}) {
  const t = await createTestApp();
  opened.push(t);
  // 무보관 계약을 확인한 실제 모델처럼 돌려요. 공급자가 없으면 계약 전(등급 1 거절 → 규칙 제안)이에요.
  if (o.provider) t.ctx.gateway = new AiGateway(o.provider, true, t.db);
  t.ctx.ops.patchValues({ rateLimitPerMinute: 1000 });
  return t;
}

let seq = 0;
function notice(title: string, body: string): NoticeCopy {
  seq += 1;
  return {
    id: `N-7${String(seq).padStart(3, '0')}`,
    board: '전사 공지',
    title,
    postedOn: '2026-10-26',
    url: `https://groupware.example.com/board/notice/7${seq}`,
    body,
  };
}

const DEV_CHECK = () => notice('개발팀 노트북 보안 점검 안내', '개발팀은 11월 12일까지 노트북 보안 점검을 받아 주세요. 문의는 정보보안팀으로 해 주세요.');
const DEV = [MOCK.dev, MOCK.devMember, 'mock|emp-007', 'mock|emp-015'];

const pseudo = (t: TestApp, subject: string) => pseudonymize(t.ctx.config.pseudonymSecret, subject);
async function targetNotifications(t: TestApp): Promise<Map<string, number>> {
  const { rows } = await t.db.query<{ who: string; n: number }>(
    'select audience_pseudonym as who, count(*)::int as n from notifications where title = $1 group by audience_pseudonym',
    [NOTICE_AUDIENCE_TEXT.notifyTarget],
  );
  return new Map(rows.map((r) => [r.who, Number(r.n)]));
}
const list = async (s: Awaited<ReturnType<TestApp['loginAs']>>) => (await s.call('GET', '/api/notices/audience')).body as NoticeAudienceListResponse;

describe('대상 제안: 계약 전 규칙(공지 글의 낱말)', () => {
  const options = {
    departments: ['개발팀', '디자인팀', '재무팀', '정보보안팀', '총무팀'],
    floors: ['2층', '3층', '5층'],
    roles: ['team-lead', 'facilities'] as const,
  };

  it('본문에 나온 부서·층·역할 이름을 대상으로 하고, 문의처 문장의 부서는 대상으로 보지 않아요', () => {
    const dev = DEV_CHECK();
    expect(proposeByRules(dev.title, dev.body, options)).toEqual({
      audience: { everyone: false, departments: ['개발팀'], floors: [], roles: [] },
      evidence: ['개발팀'],
      byModel: false,
    });
    expect(proposeByRules('3층 화장실 공사 안내', '3 층 화장실은 11월 9일 하루 쓸 수 없어요. 문의: 총무팀', options).audience).toEqual({
      everyone: false,
      departments: [],
      floors: ['3층'],
      roles: [],
    });
    expect(proposeByRules('리더십 교육 안내', '팀장은 11월 18일 리더십 교육을 들어 주세요.', options).audience.roles).toEqual(['team-lead']);
  });

  it('"전 직원" 같은 말이 있거나 아무것도 못 찾으면 모두예요', () => {
    expect(proposeByRules('소방 훈련 안내', '전 직원은 11월 20일 오후 소방 훈련에 참여해 주세요. 개발팀도 예외 없어요.', options)).toEqual({
      audience: { everyone: true, departments: [], floors: [], roles: [] },
      evidence: ['전 직원'],
      byModel: false,
    });
    expect(proposeByRules('구내식당 메뉴 개편', '다음 주부터 점심 메뉴가 바뀌어요.', options)).toEqual({
      audience: { everyone: true, departments: [], floors: [], roles: [] },
      evidence: [],
      byModel: false,
    });
  });

  it('조건끼리는 "또는"이에요(어느 하나에 맞으면 받아요)', () => {
    const a = { everyone: false, departments: ['재무팀'], floors: ['5층'], roles: ['facilities' as const] };
    expect(matchesAudience({ department: '재무팀', floor: '3층', roles: [] }, a)).toBe(true);
    expect(matchesAudience({ department: '디자인팀', floor: '5층', roles: [] }, a)).toBe(true);
    expect(matchesAudience({ department: '총무팀', floor: '2층', roles: ['employee', 'facilities'] }, a)).toBe(true);
    expect(matchesAudience({ department: '인사팀', floor: '2층', roles: ['employee'] }, a)).toBe(false);
  });

  it('목록 밖 이름은 버리고, 다 버려지면 모두예요', () => {
    expect(cleanProposal({ everyone: false, departments: ['개발팀', '마케팅팀'], floors: ['5 층', '99층'], roles: ['team-lead', 'ceo'] }, options)).toEqual({
      everyone: false,
      departments: ['개발팀'],
      floors: ['5층'],
      roles: ['team-lead'],
    });
    expect(cleanProposal({ everyone: false, departments: ['마케팅팀'], floors: [], roles: [] }, options).everyone).toBe(true);
  });

  it('계약 전에는 모델을 부르지 않고 규칙으로 제안해요(AI 정리 없음)', async () => {
    const t = await setup();
    expect(await t.ctx.services.notices!.ingest!(DEV_CHECK())).toEqual({ copied: true, audience: 'pending' });
    const items = (await list(await t.loginAs(MOCK.facilities))).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      audience: { everyone: false, departments: ['개발팀'], floors: [], roles: [] },
      evidence: ['개발팀'],
      byModel: false,
      count: 4,
    });
    expect((await t.db.query('select * from ai_usage')).rows).toEqual([]);
  });
});

describe('대상 제안: 모델(무보관 계약 확인 뒤)', () => {
  it('모델에는 공지 제목·본문과 부서·층·역할 이름만 가요. 사람 이름·인원 수는 없어요(등급 1)', async () => {
    const provider = new RecordingProvider();
    const t = await setup({ provider });
    const n = DEV_CHECK();
    await t.ctx.services.notices!.ingest!(n);
    const calls = provider.inputs.filter((i) => i.purpose === 'notice-audience');
    expect(calls).toHaveLength(1);
    const people = [];
    for (const d of await t.adapters.employees.departments()) people.push(...(await t.adapters.employees.departmentMembers(d, 100)));
    expect(calls[0]!.input).toBe(modelInput(n.title, n.body, optionsOf(people)));
    expect(calls[0]!.grade).toBe(1);
    expect(calls[0]!.input).toContain('부서 목록: 개발팀, 디자인팀');
    expect(calls[0]!.input).toContain('역할 목록: 팀장, 총무');
    for (const p of people) {
      expect(calls[0]!.input).not.toContain(p.displayName);
      expect(calls[0]!.input).not.toContain(p.displayName.split(' ').at(-1)!);
      expect(calls[0]!.input).not.toContain(p.email!);
    }
    expect(calls[0]!.input).not.toMatch(/\d+\s*명/);
  });

  it('모델이 목록 밖 이름·원문에 없는 근거를 내면 버려요. 모델이 골랐으면 AI 정리예요', async () => {
    const provider = new RecordingProvider({
      everyone: false,
      departments: ['개발팀', '마케팅팀'],
      floors: ['99층'],
      roles: ['팀장', '사장'],
      evidence: ['개발팀은', '지어낸 이유예요', '노트북 보안 점검'],
    });
    const t = await setup({ provider });
    await t.ctx.services.notices!.ingest!(DEV_CHECK());
    const item = (await list(await t.loginAs(MOCK.facilities))).items[0]!;
    expect(item.audience).toEqual({ everyone: false, departments: ['개발팀'], floors: [], roles: ['team-lead'] });
    expect(item.evidence).toEqual(['개발팀은', '노트북 보안 점검']);
    expect(item.byModel).toBe(true);
    // 개발팀 넷 + 디자인팀장 지우 = 5명(이름은 내보내지 않아요)
    expect(item.count).toBe(5);
    expect(JSON.stringify(item)).not.toMatch(/가상 (직원|총무|인사|운영자)|mock\||@corp\.example/);
  });

  it('모델이 목록 밖 이름만 내면 모두로 제안해요', async () => {
    const provider = new RecordingProvider({ everyone: false, departments: ['마케팅팀'], floors: [], roles: [], evidence: [] });
    const t = await setup({ provider });
    await t.ctx.services.notices!.ingest!(DEV_CHECK());
    const item = (await list(await t.loginAs(MOCK.facilities))).items[0]!;
    expect(item.audience.everyone).toBe(true);
    expect(item.count).toBe(17);
  });
});

describe('총무 확인과 보내기', () => {
  it('확인 전에는 대상자 알림이 0건이고, 총무에게만 "새 공지 알림 대상을 확인해 주세요"가 가요', async () => {
    const t = await setup();
    await t.ctx.services.notices!.ingest!(DEV_CHECK());
    expect((await targetNotifications(t)).size).toBe(0);
    const seoyeon = await t.loginAs(MOCK.facilities);
    const mine = (await seoyeon.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(mine.items.map((i) => [i.title, i.page])).toEqual([[NOTICE_AUDIENCE_TEXT.notifyReview, 'notices']]);
    const haneul = await t.loginAs(MOCK.staff);
    expect(((await haneul.call('GET', '/api/notifications')).body as NotificationsResponse).items).toEqual([]);
  });

  it('[알리기] 뒤 조건에 맞는 재직자에게만 1건씩 가고, 두 번 눌러도 1건이에요. 알림 글에 공지 제목·본문이 없어요', async () => {
    const t = await setup();
    const n = DEV_CHECK();
    await t.ctx.services.notices!.ingest!(n);
    const seoyeon = await t.loginAs(MOCK.facilities);
    const id = (await list(seoyeon)).items[0]!.id;
    const first = await seoyeon.call('POST', `/api/notices/audience/${id}/send`, {});
    expect(first).toEqual({ status: 200, body: { id, state: 'sent', sent: 4 } satisfies NoticeAudienceDecisionResponse });
    const again = await seoyeon.call('POST', `/api/notices/audience/${id}/send`, {});
    expect(again.body).toEqual(first.body);

    const got = await targetNotifications(t);
    expect([...got.keys()].sort()).toEqual(DEV.map((s) => pseudo(t, s)).sort());
    expect([...got.values()]).toEqual([1, 1, 1, 1]);
    // 알림 글은 정해진 문구뿐이에요. 공지 제목·본문·근거 말은 알림 표 어디에도 없어요.
    const json = JSON.stringify((await t.db.query('select title, page, module from notifications')).rows);
    expect(json).not.toContain('보안 점검');
    expect(json).not.toContain(n.title);
    const doyun = await t.loginAs(MOCK.dev);
    const bell = (await doyun.call('GET', '/api/notifications')).body as NotificationsResponse;
    expect(bell.items.map((i) => [i.title, i.page])).toEqual([[NOTICE_AUDIENCE_TEXT.notifyTarget, 'notices']]);

    // 다른 총무가 이미 처리한 공지를 또 누르면 409예요(공지 한 건에 한 번).
    t.adapters.employees.setGroups(MOCK.hr, ['facilities']);
    const jihu = await t.loginAs(MOCK.hr);
    expect((await jihu.call('POST', `/api/notices/audience/${id}/send`, {})).status).toBe(409);
    expect([...(await targetNotifications(t)).values()]).toEqual([1, 1, 1, 1]);

    // 감사 로그에는 정해진 칸(동작·결과·대상 수)만 있어요. 제목·조건 값은 없어요.
    const audit = (
      await t.db.query<{ pseudonym_id: string; channel: string; action: string; result: string }>(
        "select pseudonym_id, channel, action, result from audit_log where module = 'notices' order by id",
      )
    ).rows;
    expect(audit).toEqual([
      { pseudonym_id: 'system', channel: 'write', action: 'notice-audience-propose', result: 'rules' },
      { pseudonym_id: pseudo(t, MOCK.facilities), channel: 'write', action: 'notice-audience-send', result: 'sent:4' },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/개발팀|보안|N-7/);
  });

  it('대상이 아닌 사람은 알림이 0건이지만 공지 탭에서는 그대로 보여요. 대상자에게는 "나에게 해당할 수 있어요"예요', async () => {
    const t = await setup();
    const n = DEV_CHECK();
    await t.ctx.services.notices!.ingest!(n);
    const seoyeon = await t.loginAs(MOCK.facilities);
    await seoyeon.call('POST', `/api/notices/audience/${(await list(seoyeon)).items[0]!.id}/send`, {});

    const haneul = await t.loginAs(MOCK.staff);
    expect((await targetNotifications(t)).get(pseudo(t, MOCK.staff))).toBeUndefined();
    const fresh = (await haneul.call('GET', '/api/notices/new')).body as NewNoticesResponse;
    expect(fresh.items).toEqual([{ id: n.id, title: n.title, postedOn: '2026-10-26', url: n.url, board: '전사 공지', forMe: false }]);
    // 공지 찾기에서도 그대로 찾아져요.
    const asked = (await haneul.call('POST', '/api/ask', { text: '노트북 보안 점검', kind: 'notices' })).body as AskResponse;
    expect(asked.cards[0]!.id).toBe(`notice-${n.id}`);

    const seojun = await t.loginAs(MOCK.devMember);
    expect(((await seojun.call('GET', '/api/notices/new')).body as NewNoticesResponse).items[0]!.forMe).toBe(true);
  });

  it('[대상 바꾸기]로 고친 조건으로 보내고, 대상 수만 세요. 목록 밖 이름·빈 조건은 400이에요', async () => {
    const t = await setup();
    await t.ctx.services.notices!.ingest!(DEV_CHECK());
    const seoyeon = await t.loginAs(MOCK.facilities);
    const { items, options } = await list(seoyeon);
    // 칩으로 고를 이름은 재직자 명단의 부서·층과 정해진 역할이에요(사람 이름·수는 없어요).
    expect([...options.departments].sort()).toEqual(['IT지원팀', '개발팀', '디자인팀', '영업팀', '인사팀', '재무팀', '정보보안팀', '총무팀', '카페팀'].sort());
    expect(options.floors).toEqual(['1층', '2층', '3층', '4층', '5층']);
    expect(options.roles).toEqual([
      { code: 'team-lead', label: '팀장' },
      { code: 'facilities', label: '총무' },
    ]);
    const floor3 = { everyone: false, departments: [], floors: ['3층'], roles: [] };
    expect(await seoyeon.call('POST', '/api/notices/audience/count', { audience: floor3 })).toEqual({ status: 200, body: { count: 4 } });
    expect((await seoyeon.call('POST', '/api/notices/audience/count', { audience: { ...floor3, floors: ['9층'] } })).status).toBe(400);
    expect((await seoyeon.call('POST', '/api/notices/audience/count', { audience: { ...floor3, floors: [] } })).status).toBe(400);
    expect((await seoyeon.call('POST', '/api/notices/audience/count', { audience: { ...floor3, everyone: true } })).status).toBe(400);
    expect((await seoyeon.call('POST', '/api/notices/audience/count', { audience: { ...floor3, roles: ['ceo'] } })).status).toBe(400);

    const sent = await seoyeon.call('POST', `/api/notices/audience/${items[0]!.id}/send`, { audience: floor3 });
    expect(sent.body).toMatchObject({ state: 'sent', sent: 4 });
    expect([...(await targetNotifications(t)).keys()].sort()).toEqual(
      ['mock|emp-001', 'mock|emp-009', 'mock|emp-010', 'mock|emp-013'].map((s) => pseudo(t, s)).sort(),
    );
    // 보낸 뒤 확인 화면에는 보낸 조건과 보낸 수가 남아요(누구에게 갔는지는 없어요).
    expect((await list(seoyeon)).items[0]).toMatchObject({ state: 'sent', audience: floor3, count: 4, auto: false });
  });

  it('[알리지 않기]면 알림이 가지 않고, 공지는 공지 탭에 그대로 있어요', async () => {
    const t = await setup();
    const n = DEV_CHECK();
    await t.ctx.services.notices!.ingest!(n);
    const seoyeon = await t.loginAs(MOCK.facilities);
    const id = (await list(seoyeon)).items[0]!.id;
    expect((await seoyeon.call('POST', `/api/notices/audience/${id}/skip`)).body).toEqual({ id, state: 'skipped', sent: 0 });
    expect((await seoyeon.call('POST', `/api/notices/audience/${id}/send`, {})).status).toBe(409);
    expect((await targetNotifications(t)).size).toBe(0);
    const doyun = await t.loginAs(MOCK.dev);
    expect(((await doyun.call('GET', '/api/notices/new')).body as NewNoticesResponse).items).toMatchObject([{ id: n.id, forMe: false }]);
  });

  it('총무가 아니면 확인 화면·대상 수·[알리기]·[알리지 않기]가 403이에요', async () => {
    const t = await setup();
    await t.ctx.services.notices!.ingest!(DEV_CHECK());
    const id = (await list(await t.loginAs(MOCK.facilities))).items[0]!.id;
    for (const who of [MOCK.staff, MOCK.dev, MOCK.operator]) {
      const s = await t.loginAs(who);
      expect((await s.call('GET', '/api/notices/audience')).status, who).toBe(403);
      expect((await s.call('POST', '/api/notices/audience/count', { audience: { everyone: true, departments: [], floors: [], roles: [] } })).status).toBe(403);
      expect((await s.call('POST', `/api/notices/audience/${id}/send`, {})).status).toBe(403);
      expect((await s.call('POST', `/api/notices/audience/${id}/skip`)).status).toBe(403);
    }
    expect((await targetNotifications(t)).size).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/notices/new' })).statusCode).toBe(401);
  });
});

describe('자동 보내기 스위치(운영, 기본 끔)', () => {
  it('기본은 끔이라 확인을 기다리고, 켜면 모델이 고른 제안만 확인 없이 보내요', async () => {
    const provider = new RecordingProvider({ everyone: false, departments: [], floors: ['3층'], roles: [], evidence: ['3층 화장실'] });
    const t = await setup({ provider });
    expect(t.ctx.ops.get().noticeAutoSend).toBe(false);
    expect(await t.ctx.services.notices!.ingest!(DEV_CHECK())).toEqual({ copied: true, audience: 'pending' });
    expect((await targetNotifications(t)).size).toBe(0);

    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'noticeAutoSend', value: true })).status).toBe(200);
    const roof = notice('3층 화장실 공사 안내', '3층 화장실은 11월 9일 하루 쓸 수 없어요. 문의는 총무팀으로 해 주세요.');
    expect(await t.ctx.services.notices!.ingest!(roof)).toEqual({ copied: true, audience: 'sent' });
    const got = await targetNotifications(t);
    expect([...got.keys()].sort()).toEqual(['mock|emp-001', 'mock|emp-009', 'mock|emp-010', 'mock|emp-013'].map((s) => pseudo(t, s)).sort());
    const items = (await list(await t.loginAs(MOCK.facilities))).items;
    expect(items.find((i) => i.notice.id === roof.id)).toMatchObject({ state: 'sent', auto: true, count: 4 });
    const audit = (await t.db.query("select pseudonym_id, action, result from audit_log where action = 'notice-audience-auto'")).rows;
    expect(audit).toEqual([{ pseudonym_id: 'system', action: 'notice-audience-auto', result: 'sent:4' }]);

    // 다시 끄면 확인 대기로 돌아가요.
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'noticeAutoSend', value: false })).status).toBe(200);
    expect(await t.ctx.services.notices!.ingest!(notice('팀장 리더십 교육', '팀장은 11월 18일 리더십 교육을 들어 주세요.'))).toEqual({
      copied: true,
      audience: 'pending',
    });
  });

  it('켜져 있어도 낱말 규칙 제안(계약 전·모델 실패)은 보내지 않고 총무 확인으로 돌려요', async () => {
    // 공급자가 없으면 계약 전이라 규칙 제안이에요. 규칙은 정답률 표에서 사람을 놓쳐서 자동으로 보내지 않아요(11/6).
    const t = await setup();
    const op = await t.loginAs(MOCK.operator);
    expect((await op.call('PUT', '/api/ops/flag', { flag: 'noticeAutoSend', value: true })).status).toBe(200);
    const roof = notice('3층 화장실 공사 안내', '3층 화장실은 11월 9일 하루 쓸 수 없어요. 문의는 총무팀으로 해 주세요.');
    expect(await t.ctx.services.notices!.ingest!(roof)).toEqual({ copied: true, audience: 'pending' });
    expect((await targetNotifications(t)).size).toBe(0);
    const item = (await list(await t.loginAs(MOCK.facilities))).items.find((i) => i.notice.id === roof.id)!;
    expect(item).toMatchObject({ state: 'pending', auto: false, byModel: false });
    expect((await t.db.query("select 1 from audit_log where action = 'notice-audience-auto'")).rows).toHaveLength(0);
  });

  it('같은 공지가 다시 들어오면 새로 제안하지 않아요. 공지 기능이 꺼져 있으면 제안하지 않아요', async () => {
    const t = await setup();
    const n = DEV_CHECK();
    await t.ctx.services.notices!.ingest!(n);
    expect(await t.ctx.services.notices!.ingest!(n)).toEqual({ copied: false, audience: null });
    expect(await t.ctx.services.notices!.ingest!({ ...notice('인사 발령', '개발팀 발령이에요.'), board: '인사 발령' })).toEqual({
      copied: false,
      audience: null,
    });
    expect(Number((await t.db.query<{ n: number }>('select count(*)::int as n from notice_audience')).rows[0]!.n)).toBe(1);

    const op = await t.loginAs(MOCK.operator);
    await op.call('PUT', '/api/ops/switch', { module: 'notices', value: 'link' });
    expect(await t.ctx.services.notices!.ingest!(notice('2층 정수기 교체', '2층 정수기를 바꿔요.'))).toEqual({ copied: true, audience: null });
    const seoyeon = await t.loginAs(MOCK.facilities);
    expect((await seoyeon.call('GET', '/api/notices/audience')).status).toBe(409);
  });
});

describe('보관 7일', () => {
  it('제안·확인 줄은 7일 뒤 지워지고, 지운 뒤에는 보내지 못해요', async () => {
    const t = await setup();
    await t.ctx.services.notices!.ingest!(DEV_CHECK());
    const seoyeon = await t.loginAs(MOCK.facilities);
    const id = (await list(seoyeon)).items[0]!.id;
    t.advance(6 * 24 * 60 * 60 * 1000);
    expect(await t.runRetention()).toEqual([]);
    expect((await list(await t.loginAs(MOCK.facilities))).items).toHaveLength(1);
    t.advance(2 * 24 * 60 * 60 * 1000);
    expect(await t.runRetention()).toEqual([]);
    expect(Number((await t.db.query<{ n: number }>('select count(*)::int as n from notice_audience')).rows[0]!.n)).toBe(0);
    const again = await t.loginAs(MOCK.facilities);
    expect((await list(again)).items).toEqual([]);
    expect((await again.call('POST', `/api/notices/audience/${id}/send`, {})).status).toBe(404);
    expect(((await again.call('GET', '/api/notices/new')).body as NewNoticesResponse).items).toEqual([]);
  });
});
