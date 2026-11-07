import { NOTICE_AUDIENCE_TEXT, type NoticeAudienceItem, type NoticeAudienceListResponse } from '@one-line-desk/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionHost } from '../../components/ActionHost';
import { audienceText, ReviewItem } from './AudienceReview';

// 새 공지 알림 대상 확인(11/6, 총무). 문구는 docs/화면설계.md "보안이 보이는 문구" 표 그대로예요. 서버 경로는 apps/server/src/modules/notices/audience.test.ts.

const host = (children: ReactNode) =>
  renderToStaticMarkup(
    <ActionHost onNavigate={() => undefined} inviteChannels={{ calendar: null, slack: null }}>
      {children}
    </ActionHost>,
  );

const options: NoticeAudienceListResponse['options'] = {
  departments: ['개발팀', '재무팀'],
  floors: ['3층', '5층'],
  roles: [
    { code: 'team-lead', label: '팀장' },
    { code: 'facilities', label: '총무' },
  ],
};

const item: NoticeAudienceItem = {
  id: '7',
  notice: {
    id: 'GB-1a2b3c4d',
    title: '개발팀 노트북 보안 점검 안내',
    postedOn: '2026-11-06',
    url: 'https://groupware.example.com/board/notice/7',
    board: '전사 공지',
  },
  audience: { everyone: false, departments: ['개발팀'], floors: ['5층'], roles: ['team-lead'] },
  count: 6,
  evidence: ['개발팀은'],
  byModel: true,
  state: 'pending',
  auto: false,
  createdAt: '11월 6일(금) 10:02',
};

describe('새 공지 알림 대상 확인(총무)', () => {
  it('제목·게시일·원문 링크, 제안 대상 칩, 대상 수(이름 없음), 근거와 [알리기]·[대상 바꾸기]·[알리지 않기]를 보여요', () => {
    const html = host(<ReviewItem item={item} options={options} />);
    expect(html).toContain('개발팀 노트북 보안 점검 안내');
    expect(html).toContain('2026-11-06 · 전사 공지');
    expect(html).toContain('href="https://groupware.example.com/board/notice/7"');
    for (const chip of ['개발팀', '5층', '팀장']) expect(html).toContain(`<span class="chip selected">${chip}</span>`);
    expect(html).toContain('6명 · 이름은 보이지 않아요');
    expect(html).toContain('공지에 나온 말: “개발팀은”');
    expect(html).toContain('AI 정리');
    for (const button of ['알리기', '대상 바꾸기', '알리지 않기']) expect(html).toContain(`>${button}</button>`);
    expect(html).toContain('알림에는 공지 제목·내용이 들어가지 않아요');
  });

  it('규칙 제안이면 AI 정리가 없고, 근거 말이 없으면 "모두에게 보내는 안"이라고 알려요', () => {
    const html = host(
      <ReviewItem
        item={{ ...item, byModel: false, evidence: [], audience: { everyone: true, departments: [], floors: [], roles: [] }, count: 17 }}
        options={options}
      />,
    );
    expect(html).not.toContain('AI 정리');
    expect(html).toContain(NOTICE_AUDIENCE_TEXT.noEvidence);
    expect(html).toContain('<span class="chip selected">모두</span>');
    expect(html).toContain('17명');
  });

  it('대상 글은 "개발팀 · 5층 · 팀장"이나 "모두"예요', () => {
    expect(audienceText(item.audience)).toBe('개발팀 · 5층 · 팀장');
    expect(audienceText({ everyone: true, departments: [], floors: [], roles: [] })).toBe('모두');
  });
});
