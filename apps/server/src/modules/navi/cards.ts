import type { Card, CardAction } from '@one-line-desk/shared';
import { makeCard } from '../../core/cards';
import type { ChartRow } from './chart-csv';
import { GENERAL_DESK } from './fixtures';

// 담당 카드(ADR-09). 카드의 사실은 모두 분장표 행 원문이에요. 사람 이름은 행에도 카드에도 없어요.

export const ASK_TAIL = '질문 원문은 저장하지 않아요';
export const NO_PERIOD = '분장표에 없음';

type CardRow = Pick<ChartRow, 'id' | 'task' | 'team' | 'desk' | 'deskUrl' | 'nextStep' | 'processingPeriod'> & { revisedOn: string };

export function rowEvidence(row: Pick<CardRow, 'task' | 'revisedOn'>): string {
  return `분장표 "${row.task}" 행 · 개정일 ${row.revisedOn}`;
}

export function candidateLabel(row: Pick<CardRow, 'task' | 'team'>): string {
  return `${row.task} · ${row.team}`;
}

/**
 * 근거 행 하나로 담당 카드를 그려요.
 * - aiSummarized: AI가 후보 중에서 이 행을 골랐을 때만 true예요(화면설계 "AI 정리").
 * - others: "틀렸어요 → 다른 담당이에요"에 보여 줄 다른 후보(최대 3개). 없으면 틀렸어요를 붙이지 않아요(직접 고른 행 카드).
 */
export function naviCard(row: CardRow, opts: { aiSummarized: boolean; others?: CardRow[] }): Card {
  const primary: CardAction | undefined = row.deskUrl ? { type: 'link', text: '창구 열기', href: row.deskUrl } : undefined;
  return makeCard({
    id: `navi-${row.id}`,
    kind: 'navi',
    label: '안내',
    headline: `${row.team}에서 맡아요`,
    fields: [
      { name: '업무 이름', value: row.task },
      { name: '담당 팀·창구', value: `${row.team} · ${row.desk}` },
      { name: '지금 할 일', value: row.nextStep },
      { name: '처리 기간', value: row.processingPeriod ?? NO_PERIOD },
    ],
    evidence: { text: rowEvidence(row), aiSummarized: opts.aiSummarized },
    ...(primary ? { primary } : {}),
    ...(opts.others
      ? {
          wrong: {
            predictedKind: 'navi' as const,
            predictedRowId: row.id,
            candidates: opts.others.slice(0, 3).map((o) => ({ id: o.id, label: candidateLabel(o) })),
          },
        }
      : {}),
    tail: ASK_TAIL,
  });
}

/** 근거 행이 없을 때: 담당 카드를 만들지 않고 총무 창구로 보내요(F1-5). */
export function askHereCard(): Card {
  return makeCard({
    id: 'navi-ask-here',
    kind: 'navi',
    label: '안내',
    headline: '분장표에서 맞는 곳을 못 찾았어요',
    fields: [{ name: '여기로 물어보세요', value: `${GENERAL_DESK.team} · ${GENERAL_DESK.desk}` }],
    evidence: { text: '총무 창구 정보', href: GENERAL_DESK.url, aiSummarized: false },
    primary: { type: 'link', text: '총무 창구 열기', href: GENERAL_DESK.url },
    tail: ASK_TAIL,
  });
}
