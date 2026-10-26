import { checkItemName, previewSentence, sameItemHeadline } from '@one-line-desk/shared';
import { describe, expect, it } from 'vitest';
import { CATALOG_FIXTURES } from './fixtures/catalog';
import { matchCatalogByRule, normalizeName, pairsByRule, sameByRule, similarByRule } from './similarity';

const catalog = CATALOG_FIXTURES;

describe('같은 상품 이름 규칙(R15 결정적 대안)', () => {
  it('숫자·단위·포장 말과 띄어쓰기를 빼고 다른 말을 맞춰요', () => {
    expect(normalizeName('코카콜라 제로 355')).toBe('콜라제로');
    expect(normalizeName('Coke Zero 500mL')).toBe('콜라제로');
    expect(normalizeName('제로 콜라 캔')).toBe('제로콜라');
    expect(normalizeName('생수 2L 박스')).toBe('생수');
  });

  it('글자 순서만 다른 이름과 같은 카탈로그 품목은 같은 상품이에요', () => {
    expect(sameByRule('제로콜라', '코카콜라 제로 355', catalog)).toBe(true);
    expect(sameByRule('녹차', '녹차 티백 100개입', catalog)).toBe(true);
    expect(sameByRule('물', '생수 500mL', catalog)).toBe(true);
  });

  it('맛·종류가 다르면 같은 상품이 아니에요(콜라와 제로콜라)', () => {
    expect(sameByRule('콜라', '제로콜라', catalog)).toBe(false);
    expect(sameByRule('사이다', '제로사이다', catalog)).toBe(false);
    expect(sameByRule('물', '물티슈', catalog)).toBe(false);
  });

  it('카탈로그 매칭은 이름·다른 말에서 찾고, 없으면 null이에요', () => {
    expect(matchCatalogByRule('제로콜라', catalog)).toBe('cat-coke-zero');
    expect(matchCatalogByRule('콜라 제로 캔', catalog)).toBe('cat-coke-zero');
    expect(matchCatalogByRule('해바라기씨', catalog)).toBe('cat-sunflower-seeds');
    expect(matchCatalogByRule('마카롱', catalog)).toBeNull();
  });

  it('후보 묶음 중 같은 상품과 묶음 쌍을 골라요', () => {
    const candidates = [
      { id: 1, names: ['코카콜라 제로 355'], catalogItemIds: ['cat-coke-zero'] },
      { id: 2, names: ['콜라'], catalogItemIds: [] },
      { id: 3, names: ['제로 콜라'], catalogItemIds: [] },
      { id: 4, names: ['바나나'], catalogItemIds: [] },
    ];
    expect(similarByRule('제로콜라', candidates, catalog)).toEqual([1, 3]);
    expect(pairsByRule(candidates, catalog)).toEqual([[1, 3]]);
  });
});

describe('판에 올릴 이름 검사(ADR-04 게시 직전 재검사)', () => {
  it('[F3-3] 건강 정보는 막고 공통 문구를 보여 줘요', () => {
    const r = checkItemName('땅콩 알레르기용 과자');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('알레르기 같은 건강 정보는 받지 않아요');
  });

  it('[F3-3] 전화번호·이메일·사람 이름 패턴을 막아요', () => {
    expect(checkItemName('생수 010-1234-5678').message).toBe('올릴 수 없는 글자가 있어요: [전화번호]');
    expect(checkItemName('커피 a.b@example.com').message).toBe('올릴 수 없는 글자가 있어요: [이메일]');
    expect(checkItemName('김가상 대리 커피').message).toBe('올릴 수 없는 글자가 있어요: [사람 이름]');
    expect(checkItemName(' 앞에 빈칸').blocked).toContain('shape');
    expect(checkItemName('[이메일] 커피').message).toBe('올릴 수 없는 글자가 있어요: [이메일]');
  });

  it('보통 품목 이름은 지나가요("해바라기씨"·"프로틴바"처럼 호칭과 닮은 말 포함)', () => {
    for (const name of ['코카콜라 제로 355', '해바라기씨', '프로틴바', '녹차(티백)', 'Banana 🍌', '책임감 있는 커피']) {
      expect(checkItemName(name)).toMatchObject({ ok: true, message: null });
    }
  });

  it('미리보기 문구는 받침에 맞춰 조사를 골라요', () => {
    expect(previewSentence('코카콜라 제로')).toBe("'코카콜라 제로'라는 이름으로 우리 층 사람들에게 보여요. 내 이름은 안 보여요.");
    expect(previewSentence('녹차 티백')).toBe("'녹차 티백'이라는 이름으로 우리 층 사람들에게 보여요. 내 이름은 안 보여요.");
    expect(sameItemHeadline('코카콜라 제로 355')).toBe("'코카콜라 제로 355'와 같아 보여요");
    expect(sameItemHeadline('종이컵')).toBe("'종이컵'과 같아 보여요");
  });
});
