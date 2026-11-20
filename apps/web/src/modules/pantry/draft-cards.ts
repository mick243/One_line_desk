import type { Card } from '@one-line-desk/shared';

// 요청 쓰기 칸 결과(초안 카드 목록). 한 줄에 품목이 여럿이면 품목마다 카드가 따로 있어요(후보 2).
// 한 카드를 올리거나 +1 하면 그 카드만 치우고 나머지 미리보기는 남겨요. 다 치우면 null이라 시트가 닫혀요.

/** 목록에서 id 카드를 빼요. 남은 카드가 없으면 null이에요. */
export function dropDraftCard(list: Card[] | null, id: string): Card[] | null {
  const rest = (list ?? []).filter((c) => c.id !== id);
  return rest.length > 0 ? rest : null;
}
