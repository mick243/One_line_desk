import { recordCutoff } from '@one-line-desk/shared';
import type { AppContext } from '../../context';
import type { NaviHomeRead } from '../../core/services';
import { GENERAL_DESK } from './fixtures';
import { leaveStatusCard } from './leave-handoff';
import * as repo from './repo';

// 홈 "나에게 해당하는 일"(ADR-27)이 쓰는 navi 읽기. 홈은 ctx.services.navi.home으로만 불러요(모듈 경계).
// - 글(질문·사유·답장 본문·반려 사유)·답한 사람·보낸 사람 이름은 여기서 버려요.
// - 휴가 날은 본인이 보낸 요청의 날이라 본인 홈에만 가요(ADR-18). 남은 연차 숫자는 여기서 계산하지 않아요.
// - 받은 문의는 수만 세요. 받는 부서(분장표에 행이 있는 부서·대표 창구)가 아니면 null이에요.
export function createNaviHomeRead(ctx: AppContext): NaviHomeRead {
  return {
    async myRequests(pseudonymId) {
      const since = recordCutoff(ctx.now());
      const rows = await repo.inquiriesOfSender(ctx.db, pseudonymId, since);
      const lastReply = new Map<string, number>();
      for (const r of await repo.repliesOf(
        ctx.db,
        rows.map((i) => i.id),
      )) {
        lastReply.set(r.inquiryId, Math.max(lastReply.get(r.inquiryId) ?? 0, r.at));
      }
      return rows.map((r) => ({
        kind: r.kind === 'leave' ? ('leave' as const) : ('inquiry' as const),
        leaveType: r.kind === 'leave' ? (r.leaveType ?? 'annual') : null,
        task: r.task,
        team: r.team,
        state: r.state,
        sentAt: r.created,
        updatedAt: Math.max(r.updated, lastReply.get(r.id) ?? 0),
        hasReply: lastReply.has(r.id),
        days: r.kind === 'leave' ? (r.leaveDays ?? []).map((d) => ({ date: d.date, kind: d.kind })) : [],
      }));
    },

    // 11/6 A안 "내 휴가 신청 어떻게 됐어?": 근태 기록의 승인된 본인 휴가만 읽어요. 결재 중인 것은 그룹웨어 결재함으로 보내요.
    leaveStatus: (user, from, to) => leaveStatusCard(ctx, user, from, to),

    async newInboxCount(user) {
      const owners = ctx.services.navi ? await ctx.services.navi.ownerDepartments() : new Set<string>();
      if (!owners.has(user.department) && user.department !== GENERAL_DESK.team) return null;
      return repo.newInquiryCount(ctx.db, user.department, recordCutoff(ctx.now()));
    },
  };
}
