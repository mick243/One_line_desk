import { type Card, type CardAction, DEFAULT_OPS_SETTINGS } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionHost } from '../components/ActionHost';
import { CardView } from '../components/CardView';
import { FeaturePage } from './FeaturePage';
import { FEATURES, featureFor } from './features';
import { inquireFirst } from './inquire-first';

// 문의하기 페이지 한 흐름(11/3 사용자 결정, ADR-26 개정). 모드 전환이 없고, 질문하면 담당 카드를 먼저 보여 줘요.
// 카드의 [○○에 문의하기]가 주 버튼이고, 누르면 받을 팀이 채워진 양식이 열려요(양식을 자동으로 열지 않아요).
// 자료는 모두 가상이에요(등급 0).

const navi = FEATURES.find((f) => f.module === 'navi')!;

const routed: Extract<CardAction, { type: 'inquire' }> = {
  type: 'inquire',
  text: '재무팀에 문의하기',
  rowId: 'FIN-01',
  team: '재무팀',
  task: '법인카드 분실·정지',
  routed: { by: 'rule', alternatives: [{ rowId: null, team: '총무팀', task: '분장표에 없는 문의' }] },
};

function card(over: Partial<Card> & { actions: Card['actions'] }): Card {
  return {
    id: 'navi-FIN-01',
    kind: 'navi',
    label: '안내',
    headline: '재무팀에서 맡아요',
    fields: [{ name: '지금 할 일', value: '카드사에 정지 요청 후 재무팀 창구에 알려요' }],
    evidence: { text: '분장표 "법인카드 분실·정지" 행 · 개정일 2026-10-20', aiSummarized: false },
    tail: '질문 원문은 저장하지 않아요',
    ...over,
  } as Card;
}

const found = card({ actions: { primary: { type: 'link', text: '메일 보내기', href: 'mailto:finance@corp.example' }, secondary: [routed] } });

describe('문의하기 페이지 한 흐름(ADR-26 개정 11/3)', () => {
  it('[ADR-26 개정 시험] 모드 전환이 없고, 탭 이름·제목·버튼이 하나예요', () => {
    const html = renderToStaticMarkup(
      <ActionHost onNavigate={() => undefined} inviteChannels={{ calendar: null, slack: null }}>
        <FeaturePage feature={navi} onMove={() => undefined} />
      </ActionHost>,
    );
    expect(html).toContain('문의함');
    expect(html).toContain('무엇을 문의할까요?');
    expect(html).toContain('받을 팀 찾기');
    expect(html).not.toContain('page-mode');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('담당 찾기');
    expect(html).not.toContain('담당만 찾기');
    // 질문하기 전에는 양식(시트)이 없어요.
    expect(html).not.toContain('보내기</button>');
    expect('findMode' in navi).toBe(false);
  });

  it('[ADR-26 개정 시험] 담당 카드는 [재무팀에 문의하기]가 주 버튼이고, 창구 링크는 보조 버튼으로 남아요', () => {
    const out = inquireFirst(found);
    expect(out.actions.primary).toBe(routed);
    expect(out.actions.secondary).toEqual([{ type: 'link', text: '메일 보내기', href: 'mailto:finance@corp.example' }]);
    // 양식으로 가는 행동은 서버가 준 그대로예요: 받을 팀·누가 골랐는지·바꿀 후보가 같이 가요.
    expect(out.actions.primary).toMatchObject({ team: '재무팀', rowId: 'FIN-01', routed: { by: 'rule' } });

    const html = renderToStaticMarkup(<CardView card={out} onAction={() => undefined} />);
    expect(html).toContain('<button type="button" class="primary">재무팀에 문의하기</button>');
    expect(html).toContain('<button type="button" class="secondary">메일 보내기</button>');
    // "AI 정리"는 모델이 실제로 골랐을 때만이에요.
    expect(html).not.toContain('AI 정리');
  });

  it('[ADR-26 개정 시험] 못 찾음 카드는 [총무팀에 문의하기]가 주 버튼이에요', () => {
    const general: Extract<CardAction, { type: 'inquire' }> = {
      type: 'inquire',
      text: '총무팀에 문의하기',
      rowId: null,
      team: '총무팀',
      task: '분장표에 없는 문의',
      routed: { by: 'none', alternatives: [] },
    };
    const askHere = card({
      id: 'navi-ask-here',
      headline: '분장표에서 맞는 곳을 못 찾았어요',
      actions: { primary: { type: 'link', text: '총무 창구 열기', href: 'https://desk.example/general' }, secondary: [general] },
    });
    const out = inquireFirst(askHere);
    expect(out.actions.primary).toBe(general);
    expect(out.actions.secondary.map((a) => a.text)).toEqual(['총무 창구 열기']);
  });

  it('창구 링크가 없는 카드도 문의가 주 버튼이고, 이동 버튼은 뒤에 그대로예요', () => {
    const guide: CardAction = { type: 'navigate', text: '첫 2주에 할 일 보기', to: 'onboarding' };
    const out = inquireFirst(card({ actions: { secondary: [routed, guide] } }));
    expect(out.actions.primary).toBe(routed);
    expect(out.actions.secondary).toEqual([guide]);
  });

  it('동점 카드는 업무 칩을 먼저 골라야 해서 그대로 두고, 문의 버튼이 없거나 다른 주 버튼이 있는 카드도 그대로예요', () => {
    const tie = card({
      id: 'navi-choose-row',
      actions: {
        secondary: [
          { type: 'fixed', text: '법인카드 분실·정지 · 재무팀', method: 'POST', path: '/api/navi/rows/card', body: { rowId: 'FIN-01' } },
          { type: 'inquire', text: '총무팀에 문의하기', rowId: null, team: '총무팀', task: '분장표에 없는 문의' },
        ],
      },
    });
    expect(inquireFirst(tie)).toBe(tie);
    const move = card({ actions: { primary: { type: 'reask', text: '회의실에서 찾기', kind: 'rooms' }, secondary: [routed] } });
    expect(inquireFirst(move)).toBe(move);
    const plain = card({ actions: { primary: { type: 'link', text: '창구 열기', href: 'https://desk.example' }, secondary: [] } });
    expect(inquireFirst(plain)).toBe(plain);
  });
});

describe('문의함(11/5 사용자 결정, ADR-26 보강)', () => {
  it('홈 채팅이 켜져 있으면 제목이 "주고받은 문의를 여기서 봐요"이고, 받은 문의·내 문의 칸이 찾기 칸보다 먼저예요', () => {
    const inbox = featureFor(navi, { modules: DEFAULT_OPS_SETTINGS.modules, roomsWrite: true, homeAsk: true });
    expect(inbox.title).toBe('문의함');
    expect(inbox.question).toBe('주고받은 문의를 여기서 봐요');
    const html = renderToStaticMarkup(
      <ActionHost onNavigate={() => undefined} inviteChannels={{ calendar: null, slack: null }}>
        <FeaturePage feature={inbox} onMove={() => undefined} before={<p>받은 문의 자리</p>} inputHeading='받을 팀 찾기' />
      </ActionHost>,
    );
    expect(html.indexOf('받은 문의 자리')).toBeLessThan(html.indexOf('<h2 class="section-title">받을 팀 찾기</h2>'));
    expect(html.indexOf('<h2 class="section-title">받을 팀 찾기</h2>')).toBeLessThan(html.indexOf('placeholder='));
    // 홈 채팅을 끈 회사는 지금처럼 "무엇을 문의할까요?"예요.
    expect(featureFor(navi, { modules: DEFAULT_OPS_SETTINGS.modules, roomsWrite: true, homeAsk: false }).question).toBe('무엇을 문의할까요?');
  });
});
