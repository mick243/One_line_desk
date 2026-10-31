import { readFileSync } from 'node:fs';
import type { ItFaqRow } from '../repo';

// 시연용 가상 분장표(등급 0)예요. 실제 회사 자료가 아니에요.
// 원본 CSV에는 "담당자 이름" 칸(가상 이름)이 들어 있고, 가져오기에서 버려요(D9).
export function demoChartCsv(): string {
  return readFileSync(new URL('./chart.csv', import.meta.url), 'utf8');
}

/** 분장표에서 맞는 곳을 못 찾았을 때 보내는 곳: "여기로 물어보세요"(총무 창구). 가상 창구예요. */
export const GENERAL_DESK = {
  team: '총무팀',
  desk: '총무팀 대표 창구 ga@corp.example · 채널 #총무-문의',
  url: 'https://groupware.example.com/helpdesk/general',
} as const;

/** 시연용 가상 IT FAQ(등급 0)예요. 실제 회사 IT FAQ가 아니에요. */
export function demoItFaqs(): ItFaqRow[] {
  return JSON.parse(readFileSync(new URL('./it-faq.json', import.meta.url), 'utf8')) as ItFaqRow[];
}
