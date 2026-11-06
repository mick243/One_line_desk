import {
  formatKstDateTime,
  NOTICE_AUDIENCE_LIMITS,
  NOTICE_AUDIENCE_ROLE_LABEL,
  NOTICE_AUDIENCE_TEXT,
  NOTICE_TITLE_MAX_LENGTH,
  type NewNoticesResponse,
  type NoticeAudience,
  type NoticeAudienceDecisionResponse,
  type NoticeAudienceItem,
  type NoticeAudienceListResponse,
  recordCutoff,
} from '@one-line-desk/shared';
import type { EmployeeProfile } from '../../adapters/types';
import type { AppContext } from '../../context';
import { DeskError } from '../../core/errors';
import { pseudonymize } from '../../core/pseudonym';
import type { DeskUser } from '../../core/user';
import { type AudienceOptions, matchesAudience, optionsOf, proposeAudience, rolesOfProfile } from './audience';
import * as repo from './audience-repo';

// 새 공지 알림 대상(11/6 사용자 요청, ADR-09 개정·ADR-16 보강).
// 1) 새 공지 사본이 들어오면(onNewNotice) AI가 대상 조건을 제안하고 총무(역할 facilities)에게 "새 공지 알림 대상을 확인해 주세요" 알림을 보내요.
// 2) 총무가 확인 화면에서 [알리기](고정 버튼)를 누르면, 서버가 직원 명단에서 조건에 맞는 재직자를 골라 각자에게 내용 없는 알림을 보내요.
//    공지 한 건에 한 번만 가요(줄 잠금 + 상태 + 멱등 키). [알리지 않기]는 알림 없이 끝내요.
// 3) 자동 보내기 스위치(noticeAutoSend, 기본 끔)를 켜면 확인 없이 제안대로 보내요. 맞는 사람이 없으면 확인으로 돌려요.
// 대상 수는 서버가 세서 수만 내보내요. 이름 목록·누구에게 갔는지는 화면·API·DB(이 표)·감사 로그에 없어요.

/** 시스템이 한 일(새 공지 제안·자동 보내기)의 감사 로그 주체 */
const SYSTEM_ACTOR = 'system';
/** 직원 명단을 부서마다 이만큼까지 읽어요(대상 고르기·수 세기에만 쓰고 내보내지 않아요). */
const MEMBERS_PER_DEPARTMENT = 5000;
const LIST_LIMIT = 30;
const NEW_LIMIT = 20;
const CONTROL = /[\u0000-\u001F\u007F]/g;

const cleanTitle = (title: string) => title.replace(CONTROL, ' ').trim().slice(0, NOTICE_TITLE_MAX_LENGTH);

export function createAudienceService(ctx: AppContext) {
  /** 재직자 명단(부서마다). 서버 안에서 조건 대조·수 세기에만 써요. */
  async function roster(): Promise<EmployeeProfile[]> {
    const out: EmployeeProfile[] = [];
    for (const department of await ctx.adapters.directory.departments()) {
      out.push(...(await ctx.adapters.directory.departmentMembers(department, MEMBERS_PER_DEPARTMENT)));
    }
    return out;
  }

  const rosterOrFail = () =>
    roster().catch(() => {
      throw new DeskError('directory-unavailable', 503, '지금 직원 명단을 불러오지 못했어요. 잠시 뒤에 다시 해 주세요');
    });

  /** 조건에 맞는 재직자의 가명 ID */
  const recipients = (people: readonly EmployeeProfile[], a: NoticeAudience) =>
    people
      .filter((p) => matchesAudience({ department: p.department, floor: p.floor, roles: rolesOfProfile(p) }, a))
      .map((p) => pseudonymize(ctx.config.pseudonymSecret, p.idpSubject));

  /** 사람이 고친 조건 검사. 목록 밖 이름·빈 조건은 400이에요(모델 제안은 조용히 버리지만 사람이 보낸 값은 알려 줘요). */
  function checkAudience(a: NoticeAudience, options: AudienceOptions): NoticeAudience {
    if (a.everyone) {
      if (a.departments.length || a.floors.length || a.roles.length) throw new DeskError('bad-request', 400, '"모두"를 고르면 다른 칸은 비워 주세요');
      return { everyone: true, departments: [], floors: [], roles: [] };
    }
    const unknown = [...a.departments.filter((d) => !options.departments.includes(d)), ...a.floors.filter((f) => !options.floors.includes(f))];
    if (unknown.length) throw new DeskError('bad-request', 400, '고를 수 없는 부서·층이 있어요. 목록에서 골라 주세요');
    const audience = { everyone: false, departments: [...new Set(a.departments)], floors: [...new Set(a.floors)], roles: [...new Set(a.roles)] };
    if (!audience.departments.length && !audience.floors.length && !audience.roles.length)
      throw new DeskError('bad-request', 400, '알릴 대상을 하나 이상 골라 주세요');
    return audience;
  }

  const optionsView = (o: AudienceOptions): NoticeAudienceListResponse['options'] => ({
    departments: o.departments,
    floors: o.floors,
    roles: o.roles.map((code) => ({ code, label: NOTICE_AUDIENCE_ROLE_LABEL[code] })),
  });

  return {
    /**
     * 새 공지 사본이 들어왔을 때(공지 서비스 ingest가 불러요). 트랜잭션 밖에서 AI를 부른 뒤, 제안 줄과 알림을 한 트랜잭션으로 넣어요.
     * 공지 기능이 켬이 아니면 제안하지 않아요(null). 이미 제안한 공지면 그대로예요.
     */
    async onNewNotice(notice: { id: string; title: string; body: string }): Promise<'pending' | 'sent' | null> {
      if (ctx.ops.get().modules.notices !== 'on') return null;
      const people = await roster().catch(() => [] as EmployeeProfile[]);
      const proposal = await proposeAudience(ctx.gateway, notice, optionsOf(people));
      const ids = recipients(people, proposal.audience);
      // 자동 보내기는 맞는 사람이 있을 때만이에요. 없으면(명단을 못 읽음 등) 총무 확인으로 돌려요.
      const auto = ctx.ops.get().noticeAutoSend && ids.length > 0;
      const at = ctx.now();
      return ctx.db.tx(async (q) => {
        const id = await repo.insertAudience(q, {
          noticeId: notice.id,
          audience: proposal.audience,
          evidence: proposal.evidence,
          byModel: proposal.byModel,
          state: auto ? 'sent' : 'pending',
          auto,
          sentCount: auto ? ids.length : null,
          at,
        });
        if (!id) return null;
        if (auto) {
          await ctx.notify.toUsers(q, ids, { module: 'notices', title: NOTICE_AUDIENCE_TEXT.notifyTarget, page: 'notices' });
          await ctx.audit.record(
            { pseudonymId: SYSTEM_ACTOR, channel: 'write', module: 'notices', action: 'notice-audience-auto', result: `sent:${ids.length}` },
            q,
          );
          return 'sent';
        }
        await ctx.notify.toRole(q, 'facilities', { module: 'notices', title: NOTICE_AUDIENCE_TEXT.notifyReview, page: 'notices' });
        await ctx.audit.record(
          { pseudonymId: SYSTEM_ACTOR, channel: 'write', module: 'notices', action: 'notice-audience-propose', result: proposal.byModel ? 'model' : 'rules' },
          q,
        );
        return 'pending';
      });
    },

    /** 총무 확인 화면. 확인 대기는 지금 명단으로 센 수, 보낸 것은 보낸 수예요. 이름은 없어요. */
    async list(): Promise<NoticeAudienceListResponse> {
      const now = ctx.now();
      const people = await rosterOrFail();
      const options = optionsOf(people);
      const rows = await repo.listAudience(ctx.db, recordCutoff(now), LIST_LIMIT);
      const items: NoticeAudienceItem[] = rows.map((r) => ({
        id: r.id,
        notice: { id: r.noticeId, title: cleanTitle(r.title), postedOn: r.postedOn, url: r.url, board: r.board },
        audience: r.audience,
        count: r.state === 'pending' ? recipients(people, r.audience).length : (r.sentCount ?? 0),
        evidence: r.evidence,
        byModel: r.byModel,
        state: r.state,
        auto: r.auto,
        createdAt: formatKstDateTime(r.createdAt),
        ...(r.decidedAt !== null ? { decidedAt: formatKstDateTime(r.decidedAt) } : {}),
      }));
      return { items, options: optionsView(options), autoSend: ctx.ops.get().noticeAutoSend };
    },

    /** [대상 바꾸기]에서 고친 조건의 대상 수만 */
    async count(audience: NoticeAudience): Promise<{ count: number }> {
      const people = await rosterOrFail();
      return { count: recipients(people, checkAudience(audience, optionsOf(people))).length };
    },

    /** [알리기](고정 버튼, 총무). 조건에 맞는 재직자 각자에게 내용 없는 알림 한 건씩. 공지 한 건에 한 번만이에요. */
    async send(user: DeskUser, id: string, changed: NoticeAudience | undefined): Promise<NoticeAudienceDecisionResponse> {
      const people = await rosterOrFail();
      const chosen = changed ? checkAudience(changed, optionsOf(people)) : null;
      return ctx.fixed.run(user, {
        module: 'notices',
        action: 'notice-audience-send',
        idempotencyKey: id,
        resultCode: (r) => `sent:${r.sent}`,
        async run(q, now) {
          const row = await repo.lockAudience(q, id, recordCutoff(now));
          if (!row) throw new DeskError('not-found', 404, '그 공지를 찾지 못했어요. 7일이 지나 지워졌을 수 있어요');
          if (row.state !== 'pending') throw new DeskError('already-decided', 409, '이미 처리한 공지예요');
          const audience = chosen ?? row.audience;
          const ids = recipients(people, audience);
          if (!ids.length) throw new DeskError('no-recipients', 400, '조건에 맞는 재직자가 없어요. 대상을 바꿔 주세요');
          await ctx.notify.toUsers(q, ids, { module: 'notices', title: NOTICE_AUDIENCE_TEXT.notifyTarget, page: 'notices' });
          await repo.decideAudience(q, id, { state: 'sent', audience, sentCount: ids.length, at: now });
          return { id, state: 'sent' as const, sent: ids.length };
        },
      });
    },

    /** [알리지 않기](고정 버튼, 총무). 알림 없이 끝내요. 공지는 공지 탭에 그대로 있어요. */
    async skip(user: DeskUser, id: string): Promise<NoticeAudienceDecisionResponse> {
      return ctx.fixed.run(user, {
        module: 'notices',
        action: 'notice-audience-skip',
        idempotencyKey: id,
        resultCode: () => 'skipped',
        async run(q, now) {
          const row = await repo.lockAudience(q, id, recordCutoff(now));
          if (!row) throw new DeskError('not-found', 404, '그 공지를 찾지 못했어요. 7일이 지나 지워졌을 수 있어요');
          if (row.state !== 'pending') throw new DeskError('already-decided', 409, '이미 처리한 공지예요');
          await repo.decideAudience(q, id, { state: 'skipped', audience: row.audience, sentCount: 0, at: now });
          return { id, state: 'skipped' as const, sent: 0 };
        },
      });
    },

    /**
     * 공지 탭 "새 공지"(누구나). 최근 7일 들어온 새 공지의 제목·게시일·원문 링크와, 나에게 알림이 간 공지인지(forMe)예요.
     * 대상이 아닌 사람도 같은 목록을 봐요. forMe는 보낸 조건과 내 부서·층·역할을 대조해 계산하고 남기지 않아요.
     */
    async fresh(user: Pick<DeskUser, 'department' | 'floor' | 'roles'>): Promise<NewNoticesResponse> {
      const rows = await repo.listNew(ctx.db, recordCutoff(ctx.now()), NEW_LIMIT);
      const items = rows.map((r) => ({
        id: r.noticeId,
        title: cleanTitle(r.title),
        postedOn: r.postedOn,
        url: r.url,
        board: r.board,
        forMe: r.state === 'sent' && matchesAudience(user, r.audience),
      }));
      // 나에게 온 공지를 먼저 보여요(알림을 누르고 들어오면 맨 위에 있어요).
      return { items: [...items.filter((i) => i.forMe), ...items.filter((i) => !i.forMe)] };
    },

    /** 7일 지난 제안·확인 줄을 지워요(모듈 retention). */
    async purge(): Promise<void> {
      await repo.purgeAudience(ctx.db, recordCutoff(ctx.now()));
    },
  };
}

export type AudienceService = ReturnType<typeof createAudienceService>;

/** 경로 검사에 쓰는 조건 모양(JSON 스키마). 역할은 정해진 코드만이에요. */
export const AUDIENCE_SCHEMA = {
  type: 'object',
  required: ['everyone', 'departments', 'floors', 'roles'],
  additionalProperties: false,
  properties: {
    everyone: { type: 'boolean' },
    departments: {
      type: 'array',
      maxItems: NOTICE_AUDIENCE_LIMITS.maxEach,
      items: { type: 'string', minLength: 1, maxLength: NOTICE_AUDIENCE_LIMITS.nameMax },
    },
    floors: { type: 'array', maxItems: NOTICE_AUDIENCE_LIMITS.maxEach, items: { type: 'string', minLength: 1, maxLength: NOTICE_AUDIENCE_LIMITS.nameMax } },
    roles: { type: 'array', maxItems: 2, items: { enum: ['team-lead', 'facilities'] } },
  },
} as const;
