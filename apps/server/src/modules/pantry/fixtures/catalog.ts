// 가상 구매 카탈로그(등급 0). 실제 업체·가격이 아니에요. 단가는 원, 묶음 단위는 한 번에 사는 개수예요(ADR-05·08).
// aliases는 "다른 말"이에요. 이름 규칙 매칭(정규화 비교)과 AI 카탈로그 매칭이 같이 써요.

export interface CatalogFixture {
  id: string;
  name: string;
  unitPrice: number;
  packUnit: number;
  aliases: string[];
}

export const CATALOG_FIXTURES: CatalogFixture[] = [
  // 음료
  { id: 'cat-coke', name: '코카콜라 355', unitPrice: 900, packUnit: 24, aliases: ['콜라', '코크'] },
  { id: 'cat-coke-zero', name: '코카콜라 제로 355', unitPrice: 900, packUnit: 24, aliases: ['제로콜라', '콜라 제로', '코크 제로', '제로 코크'] },
  { id: 'cat-cider', name: '칠성사이다 355', unitPrice: 850, packUnit: 24, aliases: ['사이다'] },
  { id: 'cat-cider-zero', name: '칠성사이다 제로 355', unitPrice: 850, packUnit: 24, aliases: ['제로사이다', '사이다 제로'] },
  { id: 'cat-sprite-zero', name: '스프라이트 제로 355', unitPrice: 880, packUnit: 24, aliases: ['스프라이트'] },
  { id: 'cat-water', name: '생수 500mL', unitPrice: 300, packUnit: 40, aliases: ['물', '생수', '먹는샘물'] },
  { id: 'cat-sparkling', name: '탄산수 500mL', unitPrice: 700, packUnit: 20, aliases: ['탄산수', '스파클링 워터'] },
  { id: 'cat-orange-juice', name: '오렌지 주스 180mL', unitPrice: 700, packUnit: 30, aliases: ['오렌지주스', '주스'] },
  { id: 'cat-milk', name: '흰 우유 200mL', unitPrice: 600, packUnit: 24, aliases: ['우유', '흰우유'] },
  { id: 'cat-soy-milk', name: '두유 190mL', unitPrice: 550, packUnit: 24, aliases: ['두유'] },
  { id: 'cat-corn-tea', name: '옥수수수염차 500mL', unitPrice: 1100, packUnit: 20, aliases: ['옥수수수염차', '수염차'] },
  // 커피·차
  { id: 'cat-coffee-beans', name: '원두 1kg', unitPrice: 25000, packUnit: 1, aliases: ['원두', '커피콩', '커피 원두'] },
  { id: 'cat-coffee-mix', name: '커피믹스 100개입', unitPrice: 15000, packUnit: 1, aliases: ['믹스커피', '봉지커피', '커피 믹스'] },
  { id: 'cat-cold-brew', name: '콜드브루 원액 1L', unitPrice: 12000, packUnit: 1, aliases: ['콜드브루', '더치커피'] },
  { id: 'cat-green-tea', name: '녹차 티백 100개입', unitPrice: 9000, packUnit: 1, aliases: ['녹차', '녹차티백'] },
  { id: 'cat-barley-tea', name: '보리차 티백 100개입', unitPrice: 7000, packUnit: 1, aliases: ['보리차', '보리차티백'] },
  { id: 'cat-herb-tea', name: '캐모마일 티백 50개입', unitPrice: 8000, packUnit: 1, aliases: ['캐모마일', '허브차'] },
  // 간식
  { id: 'cat-cup-ramen', name: '컵라면 소컵', unitPrice: 900, packUnit: 30, aliases: ['컵라면', '라면'] },
  { id: 'cat-potato-chips', name: '감자칩 60g', unitPrice: 1500, packUnit: 16, aliases: ['감자칩', '포테이토칩'] },
  { id: 'cat-crackers', name: '크래커 소포장', unitPrice: 600, packUnit: 30, aliases: ['크래커'] },
  { id: 'cat-choco-bar', name: '초코바 50g', unitPrice: 1000, packUnit: 24, aliases: ['초코바', '초콜릿바'] },
  { id: 'cat-nuts', name: '하루 견과 20g', unitPrice: 700, packUnit: 50, aliases: ['견과', '견과류', '하루견과'] },
  { id: 'cat-granola-bar', name: '그래놀라 바', unitPrice: 900, packUnit: 24, aliases: ['그래놀라', '시리얼바'] },
  { id: 'cat-jelly', name: '젤리 50g', unitPrice: 800, packUnit: 20, aliases: ['젤리', '구미'] },
  { id: 'cat-sunflower-seeds', name: '해바라기씨 30g', unitPrice: 900, packUnit: 20, aliases: ['해바라기씨'] },
  { id: 'cat-banana', name: '바나나 1송이', unitPrice: 3500, packUnit: 1, aliases: ['바나나'] },
  // 비품
  { id: 'cat-paper-cup', name: '종이컵 1000개', unitPrice: 18000, packUnit: 1, aliases: ['종이컵'] },
  { id: 'cat-tissue', name: '각티슈 6개입', unitPrice: 9000, packUnit: 1, aliases: ['티슈', '각티슈', '곽티슈'] },
  { id: 'cat-wet-tissue', name: '물티슈 100매', unitPrice: 2500, packUnit: 10, aliases: ['물티슈'] },
  { id: 'cat-hand-towel', name: '핸드타월 5000매', unitPrice: 22000, packUnit: 1, aliases: ['핸드타월', '페이퍼타월', '손 닦는 종이'] },
  { id: 'cat-dish-soap', name: '주방 세제 1L', unitPrice: 4000, packUnit: 1, aliases: ['주방세제', '세제'] },
  { id: 'cat-sponge', name: '수세미 10개입', unitPrice: 3000, packUnit: 1, aliases: ['수세미'] },
  { id: 'cat-stirrer', name: '커피 젓개 1000개', unitPrice: 5000, packUnit: 1, aliases: ['젓개', '커피스틱', '머들러'] },
];

/** 층별 설정 기본값(D8: 최소 몫은 처음엔 같은 금액). 총무가 S4 설정에서 바꿔요. */
export const DEFAULT_FLOOR_SETTING = { minShareWon: 50000, perPersonLimit: 5, cycleNote: '매주 금요일 오후 3시에 마감해요' };

/** 시연 층. 가상 직원 디렉터리의 층과 같아요. */
export const DEMO_FLOORS = ['2층', '3층', '4층', '5층'];
