import { DEMO_GROUPWARE_BAND, type GroupwareDoc } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocView, GroupwareDemo } from './GroupwareDemo';

// 시연 전용 가상 그룹웨어(11/6 휴가 A안). 머리띠·신청서 미리 채움·결재 문서 그리기를 봐요(서버 경로는 apps/server/src/routes/demo-groupware.test.ts).

afterEach(() => {
  vi.unstubAllGlobals();
});

const doc: GroupwareDoc = {
  id: 'GW-0001',
  type: 'annual',
  typeLabel: '연차',
  daysText: '11월 6일(금) 하루 (1일)',
  drafter: { name: '가상 직원 서준', department: '개발팀' },
  line: [
    { label: '개발팀 팀장 가상 직원 도윤', state: 'approved', by: '가상 직원 도윤', at: '10월 26일(월) 09:10' },
    { label: '인사팀', state: 'rejected', by: '가상 인사 지후', at: '10월 26일(월) 09:20' },
  ],
  state: 'rejected',
  stateLabel: '반려',
  rejectReason: '그 주에 출시가 있어요',
  createdAt: '10월 26일(월) 09:00',
};

describe('가상 그룹웨어 화면', () => {
  it('한 줄 데스크가 아니라는 머리띠를 늘 보여 주고, 주소의 날짜·종류 코드로 신청서를 채워요', () => {
    vi.stubGlobal('window', { location: { search: '?type=sick&from=2026-11-06&to=2026-11-06&half=am' } });
    const html = renderToStaticMarkup(<GroupwareDemo page='leave' onExit={() => undefined} />);
    expect(html).toContain(DEMO_GROUPWARE_BAND);
    expect(html).toContain('가상 그룹웨어 · 시연 전용 — 한 줄 데스크가 아니에요');
    expect(html).toContain('한 줄 데스크에서 가져온 날짜·종류예요. 맞는지 보고 고쳐 주세요.');
    expect(html).toMatch(/<option value="sick" selected="">병가<\/option>/);
    expect(html).toContain('value="2026-11-06"');
    // 병가·공가·경조는 사유가 꼭 있어야 해요(11/6). 사유는 결재자와 나만 보고 한 줄 데스크로 가지 않아요.
    expect(html).toContain('사유(꼭 적어요)');
    expect(html).toContain('<textarea');
    expect(html).toContain('한 줄 데스크로는 가지 않아요');
  });

  it('{type}·{half}로 종류를 미리 골라요: 연차 오전 반차는 "반차(오전)", 경조는 "경조"(사유 꼭), 연차 사유는 골라서', () => {
    vi.stubGlobal('window', { location: { search: '?type=annual&from=2026-11-06&to=2026-11-06&half=am' } });
    const am = renderToStaticMarkup(<GroupwareDemo page='leave' onExit={() => undefined} />);
    expect(am).toMatch(/<option value="am" selected="">반차\(오전\)<\/option>/);
    expect(am).toContain('사유(골라서 적어요)');
    vi.stubGlobal('window', { location: { search: '?type=family-event&from=2026-11-06&to=2026-11-06&half=' } });
    const event = renderToStaticMarkup(<GroupwareDemo page='leave' onExit={() => undefined} />);
    expect(event).toMatch(/<option value="family-event" selected="">경조<\/option>/);
    expect(event).toContain('사유(꼭 적어요)');
    // 오전·오후를 모르는 반차면 종류를 비워 두고 사람이 골라요.
    vi.stubGlobal('window', { location: { search: '?type=annual&from=2026-11-06&to=2026-11-06&half=half' } });
    const unknown = renderToStaticMarkup(<GroupwareDemo page='leave' onExit={() => undefined} />);
    expect(unknown).toMatch(/<option value="" selected="">반차는 오전·오후를 골라 주세요<\/option>/);
  });

  it('주소 값이 모양에 맞지 않으면 버리고 연차·빈 날로 열어요', () => {
    vi.stubGlobal('window', { location: { search: '?type=<script>&from=11/06&half=x' } });
    const html = renderToStaticMarkup(<GroupwareDemo page='leave' onExit={() => undefined} />);
    expect(html).not.toContain('한 줄 데스크에서 가져온');
    expect(html).toMatch(/<option value="annual" selected="">연차<\/option>/);
    expect(html).not.toContain('script');
  });

  it('결재 문서는 결재선 칸마다 상태·결재한 사람을 보여 주고, 반려 사유를 보여 줘요', () => {
    const html = renderToStaticMarkup(<DocView doc={doc} />);
    expect(html).toContain('개발팀 팀장 가상 직원 도윤 · 승인 (가상 직원 도윤 · 10월 26일(월) 09:10)');
    expect(html).toContain('인사팀 · 반려');
    expect(html).toContain('반려 사유: 그 주에 출시가 있어요');
    // 기안자 사유는 서버가 결재자·기안자에게 줄 때만 와요. 오면 그대로 보여 줘요.
    expect(renderToStaticMarkup(<DocView doc={{ ...doc, reason: '가족 행사' }} />)).toContain('사유: 가족 행사');
    const { rejectReason: _reason, ...rest } = doc;
    const approved = renderToStaticMarkup(<DocView doc={{ ...rest, state: 'approved', stateLabel: '최종 승인', recorded: true }} />);
    expect(approved).toContain('근태 기록에 들어갔어요. 한 줄 데스크가 이 근태 기록을 읽어요.');
  });
});
