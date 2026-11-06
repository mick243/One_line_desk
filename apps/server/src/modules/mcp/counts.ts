import { kstDate, kstToEpoch, type McpCountKind } from '@one-line-desk/shared';
import type { Queryable } from '../../core/db';
import * as repo from './repo';

// MCP 월간 보고용 날마다 셈(11/3 사용자 결정, ADR-15 관리 평면 1단계 · ADR-21 예외).
// - 감사 로그(7일)를 나중에 다시 읽어 세지 않고, 감사 로그를 남기는 바로 그 자리에서 같은 흐름(tx가 있으면 같은 tx)으로 +n 해요.
// - 표(510_mcp.sql)에는 날(한국 시간)·종류·앱 이름·수만 있어요. 사람·가명 ID·클라이언트 ID·도구 입력은 없어요.
// - 보관: ADR-21은 접속기록 말고 모든 기록을 7일만 두지만, 이 표는 사용자 결정(11/3)으로 13개월 둬요.
//   사람을 가리킬 수 없는 날짜별 합계라 7일 원칙이 막으려던 개인 기록 쌓임이 없고, 달 보고(지난해 같은 달 비교 포함)에 13개월이 필요해서예요.
//   이번 달과 지난 12달(13개 달)만 남기고, 그보다 앞선 날은 mcp 모듈 retention이 한 시간마다 지워요.

/** 보관하는 달 수(이번 달 포함). */
const COUNT_KEEP_MONTHS = 13;

/** 'YYYY-MM'을 delta달 옮겨요. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** 지금(한국 시간)의 달 'YYYY-MM' */
export const kstMonth = (now: number): string => kstDate(now).slice(0, 7);

/** 그 달의 [1일, 다음 달 1일) — 날짜와 시각(한국 시간 0시) */
export function monthRange(month: string): { fromDay: string; toDay: string; from: number; to: number } {
  const fromDay = `${month}-01`;
  const toDay = `${shiftMonth(month, 1)}-01`;
  return { fromDay, toDay, from: kstToEpoch(fromDay, '00:00'), to: kstToEpoch(toDay, '00:00') };
}

/** 이 날보다 앞선 셈은 지워요: 지난 12달 전 달의 1일(이번 달 포함 13개 달을 남겨요). */
export const countCutoffDay = (now: number): string => `${shiftMonth(kstMonth(now), -(COUNT_KEEP_MONTHS - 1))}-01`;

/**
 * 셈 하나 더하기. 감사 로그를 남기는 자리에서 불러요. 앱 이름은 클라이언트 ID로 찾아 넣고(표에는 이름만), 모르면 '-'예요.
 * n이 0 이하면 아무것도 하지 않아요.
 */
export async function count(q: Queryable, now: number, kind: McpCountKind, clientId: string | null = null, n = 1): Promise<void> {
  if (n <= 0) return;
  await repo.bumpDailyCount(q, kstDate(now), kind, clientId, n);
}

/** 지운 승인들의 클라이언트 ID 목록(겹침 있음)을 앱별로 묶어 셈에 더해요. */
export async function countRemoved(q: Queryable, now: number, kind: 'disconnect' | 'disconnect.ops', clientIds: string[]): Promise<void> {
  const perClient = new Map<string, number>();
  for (const id of clientIds) perClient.set(id, (perClient.get(id) ?? 0) + 1);
  for (const [id, n] of perClient) await count(q, now, kind, id, n);
}

/** 보관 회차: 13개월(이번 달 + 지난 12달) 앞선 날의 셈을 지워요. */
export async function purgeCounts(q: Queryable, now: number): Promise<void> {
  await repo.purgeDailyCounts(q, countCutoffDay(now));
}
