import type { Card, CardAction, CardLabel } from '@one-line-desk/shared';

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
  overview?: Card['overview'];
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
    ...(input.overview ? { overview: input.overview } : {}),
    tail: input.tail,
  };
}
