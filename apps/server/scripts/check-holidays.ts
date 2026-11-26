import { KR_HOLIDAY_YEARS } from '@one-line-desk/shared';

// 다음 해 공휴일 표 확인(11/25). 우주항공청이 6월 말쯤 다음 해 월력요항을 내서, 7월부터는 다음 해 표가 있어야 해요.
// 표가 없으면 다음 해 연차 계산이 공휴일을 평일로 세요(packages/shared/src/holidays.ts). 벽시계를 보는 검사라
// PR 시험에 넣지 않고 매년 7월 예약 잡(.github/workflows/holidays.yml)과 손으로만 돌려요: npm run holidays:check
const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const year = kst.getUTCFullYear();
const need = kst.getUTCMonth() >= 6 ? [year, year + 1] : [year];
const missing = need.filter((y) => !KR_HOLIDAY_YEARS.includes(y));
if (missing.length) {
  console.error(`공휴일 표에 ${missing.join('·')}년이 없어요. 월력요항을 보고 packages/shared/src/holidays.ts에 더해 주세요`);
  process.exit(1);
}
console.log(`공휴일 표가 ${need.join('·')}년까지 있어요`);
