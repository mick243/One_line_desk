import type { Card, CardAction, CardLabel, ModuleKind } from '@one-line-desk/shared';

/** 카드 다섯 칸을 빠짐없이 채워요(화면설계 카드 문법). */
export function makeCard(input: {
  id: string;
  kind: Card['kind'];
  label: CardLabel;
  headline: string;
  fields?: Card['fields'];
  evidence: Card['evidence'];
  primary?: CardAction;
  secondary?: CardAction[];
  wrong?: Card['wrong'];
  variant?: string;
  tail: string;
}): Card {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    ...(input.variant ? { variant: input.variant } : {}),
    headline: input.headline,
    fields: input.fields ?? [],
    evidence: input.evidence,
    actions: { ...(input.primary ? { primary: input.primary } : {}), secondary: input.secondary ?? [] },
    ...(input.wrong ? { wrong: input.wrong } : {}),
    tail: input.tail,
  };
}

/** 아직 만들지 않은 모듈이 돌려주는 안내 카드. 모듈을 만들면 쓰지 않아요. */
export function notReadyCard(kind: ModuleKind, what: string): Card {
  return makeCard({
    id: `not-ready-${kind}`,
    kind,
    label: '안내',
    headline: `${what}은 아직 만들고 있어요`,
    evidence: { text: '개발 중', aiSummarized: false },
    tail: '저장되는 것이 없어요',
  });
}
