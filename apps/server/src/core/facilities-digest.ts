import { isWorkday, kstDate, kstTime } from '@one-line-desk/shared';
import type { AppContext } from '../context';
import { companyCalendar } from './work-calendar';

/** 아침 요약을 보내는 한국 시각(시). 한 시간 보관 회차 중 이 시간대에 든 첫 회차가 보내요. */
const DIGEST_HOUR = 9;

/**
 * 총무 확인 대기 아침 요약(11/25 자동화 후보 5).
 * 확인할 일마다 알림이 한 번씩만 가서, 놓친 공지 알림 대상 확인은 7일 뒤 지워지고 그 공지 알림은 영영 나가지 않아요.
 * 근무일 아침 9시대에 한 번, 모듈이 센 수를 모아 총무 역할(facilities)에게 "확인할 일이 N건 있어요"를 보내요.
 * 알림에는 종류와 수만 들어가요(이름·금액·글 없음). 결정은 그대로 총무의 고정 버튼이에요. 대기가 0이면 보내지 않아요.
 * 하루 한 번은 서버 메모리로만 기억해요. 9시대에 서버를 다시 켜면 그날 한 번 더 갈 수 있어요.
 */
export function createFacilitiesDigest(ctx: AppContext) {
  let sentDay: string | null = null;
  return async (): Promise<void> => {
    const now = ctx.now();
    const day = kstDate(now);
    if (Number(kstTime(now).slice(0, 2)) !== DIGEST_HOUR || sentDay === day || !isWorkday(day, companyCalendar(ctx))) return;
    const sources = ctx.services.facilitiesPending ?? [];
    const counts = await Promise.all(sources.map(async (s) => ({ ...s, n: await s.count() })));
    const open = counts.filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
    sentDay = day;
    if (!open.length) return;
    const total = open.reduce((sum, c) => sum + c.n, 0);
    await ctx.notify.toRole(ctx.db, 'facilities', {
      module: 'core',
      title: `확인할 일이 ${total}건 있어요 · ${open.map((c) => `${c.label} ${c.n}`).join(' · ')}`,
      page: open[0]!.page,
    });
  };
}
