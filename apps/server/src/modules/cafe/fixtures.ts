// 가상 사내 카페 메뉴(등급 0). 실제 카페·가격이 아니에요. 값은 직원가(원)이고, 옵션은 고르는 이름만이라 값이 바뀌지 않아요(ADR-29).
// 시연·개발에서 비어 있을 때 한 번만 넣어요(seed). 운영 메뉴·직원가는 총무가 정해요(S9, 다음 묶음).

interface MenuFixture {
  id: string;
  name: string;
  priceWon: number;
  options: string[];
  sort: number;
}

export const CAFE_MENU_FIXTURES: MenuFixture[] = [
  { id: 'americano', name: '아메리카노', priceWon: 2000, options: ['아이스', '핫', '연하게', '샷 추가'], sort: 10 },
  { id: 'latte', name: '카페라테', priceWon: 2500, options: ['아이스', '핫', '샷 추가'], sort: 20 },
  { id: 'vanilla-latte', name: '바닐라라테', priceWon: 3000, options: ['아이스', '핫', '샷 추가'], sort: 30 },
  { id: 'cold-brew', name: '콜드브루', priceWon: 2500, options: ['연하게'], sort: 40 },
  { id: 'green-tea-latte', name: '녹차라테', priceWon: 3000, options: ['아이스', '핫'], sort: 50 },
  { id: 'iced-tea', name: '아이스티', priceWon: 2000, options: ['샷 추가'], sort: 60 },
];
