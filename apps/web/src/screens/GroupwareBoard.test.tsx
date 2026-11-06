import { DEMO_GROUPWARE_BAND } from '@one-line-desk/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupwareDemo } from './GroupwareDemo';

// 시연 전용 가상 그룹웨어 게시판(11/6 새 공지 알림 대상). 서버 경로는 apps/server/src/routes/demo-groupware-board.test.ts.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('가상 그룹웨어 게시판 화면', () => {
  it('한 줄 데스크가 아니라는 머리띠와 [게시판] 메뉴, 공지 올리기 칸을 보여 줘요. 본문을 저장하지 않는다고 알려요', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    const html = renderToStaticMarkup(<GroupwareDemo page='board' onExit={() => undefined} />);
    expect(html).toContain(DEMO_GROUPWARE_BAND);
    expect(html).toMatch(/<button type="button" aria-current="page">게시판<\/button>/);
    expect(html).toContain('공지 올리기');
    // 제목·본문만 받아요(게시판 고르기·첨부 칸 없음, 11/6 사용자 결정).
    expect(html).not.toContain('<select');
    expect(html).not.toContain('type="file"');
    expect(html).toContain('진짜 회사 공지·이름·연락처는 쓰지 마세요');
    expect(html).toContain('본문은 저장하지 않아요');
    // 휴가 신청서 화면의 안내(근태 기록)는 게시판에 보이지 않아요.
    expect(html).not.toContain('최종 승인돼 근태 기록에 들어간 휴가만');
  });
});
