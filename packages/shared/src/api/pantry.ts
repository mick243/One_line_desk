import type { Card } from '../cards';
import { checkInput } from '../input-check/check';
import { type LockKind, MASK_RULES, type MaskKind } from '../input-check/rules';

// 주문안 줄마다 붙는 이유 코드(D8, ADR-08).
export const ORDER_REASON_CODES = ['층 최소 몫', '표 대비 값', '예산 초과로 뺌', '카탈로그에 없음'] as const;
export type OrderReasonCode = (typeof ORDER_REASON_CODES)[number];

// ── 같이 채워요 판(F3, ADR-04·07) ──────────────────────────────────────────────

/** 판에 올라가는 품목 이름 길이. DB 칸(1~60)보다 짧게 둬요. */
export const PANTRY_ITEM_NAME_MAX = 40;

/** 화면 문구(docs/화면설계.md 그대로). 서버 오류 메시지와 웹이 같이 써요. */
export const PANTRY_TEXT = {
  boardScope: '우리 층 모두에게 보여요',
  noVoterShown: '누가 표를 줬는지는 화면 어디에도 안 보여요',
  previewTail: '처음 쓴 문장은 올라가지 않아요. 내 이름은 안 보여요. 내 표 1개가 같이 들어가요',
  voteLimit: '이번 주기 표를 다 썼어요. 다른 표를 거두면 줄 수 있어요.',
  postLimit: '다른 표를 거두면 올릴 수 있어요',
  overLimit: '합치기가 풀려 상한을 넘었어요. 새 표는 거둔 뒤에 줄 수 있어요.',
  rateLimited: '요청이 많아요. 잠시 뒤에 다시 올려 주세요.',
  moveToAsk: '이건 담당 안내가 맞아 보여요',
  standaloneOnly: '여기에는 탕비실 요청만 올려요',
  conflict: '다른 총무가 먼저 이 품목을 바꿨어요. 새로 불러왔어요.',
  justPosted: '방금 같은 품목이 올라왔어요',
  otherFloor: '내 층 품목에만 표를 줄 수 있어요',
  ordered: '주문에 들어간 품목이라 표를 바꿀 수 없어요',
  emptyBoard: '아직 요청이 없어요. 첫 요청을 써 보세요.',
  emptySuggestions: '지금 합칠 만한 요청이 없어요.',
  revertNote: '표 수가 합치기 전으로 돌아가요',
} as const;

/**
 * 공개 미리보기 카드에서 [올리기]를 잠그는 표시 칸 이름. 이 칸이 있으면 표 상한이 찬 상태예요(R14).
 * 칸 값은 PANTRY_TEXT.postLimit이에요.
 */
export const PREVIEW_LIMIT_FIELD = '표 상한';

/** 판에서 고칠 수 없는 글자 종류. 막힘 카드 "올릴 수 없는 글자가 있어요: [전화번호]"에 써요. */
export type NameBlockKind = LockKind | MaskKind | 'phone' | 'person' | 'shape';

export const NAME_BLOCK_LABEL: Record<NameBlockKind, string> = {
  'key-token': '키·토큰',
  grade3: '주민번호·비밀번호',
  health: '건강 정보',
  email: '이메일',
  ip: 'IP',
  phone: '전화번호',
  person: '사람 이름',
  shape: '줄바꿈·특수 글자',
};

// 게시 직전 서버 재검사에 더하는 패턴(ADR-04). 브라우저 미리보기도 같은 함수로 다시 검사해요.
// 공통 검사(input-check/rules.ts)에 더해 전화번호·사람 이름을 막아요. 이메일·IP는 가리지 않고 막아요(공개 판이라서요).
const PHONE = /(?:\+82[-\s.]?)?0\d{1,2}[-\s.)]?\d{3,4}[-\s.]?\d{4}/;
// "김가상 대리", "가상님"처럼 이름 뒤에 호칭·직함이 붙은 모양. "해바라기씨" 같은 품목을 막지 않게 '씨'는 빼요.
const PERSON = /[가-힣]{2,4}\s?(?:님|대리|과장|차장|부장|팀장|실장|사원|주임|선임|책임|수석|매니저|이사|상무|전무)(?![가-힣])/;
// 줄바꿈·제어 문자, 앞뒤 공백. 판 글자 = 미리보기에서 확정한 글자여야 해서 서버가 손대지 않고 거부해요.
const SHAPE = /[\u0000-\u001f\u007f\u2028\u2029]|^\s|\s$/;

export interface ItemNameCheck {
  ok: boolean;
  blocked: NameBlockKind[];
  /** 막혔을 때 보여 줄 한 줄. 건강 정보는 "알레르기 같은 건강 정보는 받지 않아요"예요. */
  message: string | null;
}

/** 공개 판에 올릴 품목 이름 검사. 서버(게시 직전)와 브라우저(미리보기)가 같이 써요. */
export function checkItemName(name: string): ItemNameCheck {
  const blocked: NameBlockKind[] = [];
  const common = checkInput(name);
  for (const lock of common.locks) blocked.push(lock.kind);
  // 입력 칸에서 가린 자리표([이메일]·[IP])가 품목 이름에 남아 있어도 그대로 올리지 않아요.
  for (const rule of MASK_RULES) {
    if (common.masked[rule.kind] > 0 || name.includes(rule.label)) blocked.push(rule.kind);
  }
  if (PHONE.test(name)) blocked.push('phone');
  if (PERSON.test(name)) blocked.push('person');
  if (SHAPE.test(name)) blocked.push('shape');
  if (blocked.length === 0) return { ok: true, blocked, message: null };
  const health = common.locks.find((l) => l.kind === 'health');
  const message = blocked.length === 1 && health ? health.message : `올릴 수 없는 글자가 있어요: ${blocked.map((k) => `[${NAME_BLOCK_LABEL[k]}]`).join(' ')}`;
  return { ok: false, blocked, message };
}

/** 마지막 글자에 받침이 있는지(한글·숫자만 봐요). "라는/이라는", "와/과"를 고르는 데 써요. */
function hasFinalConsonant(word: string): boolean {
  const last = word.trim().at(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  // 0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔
  return '013678'.includes(last);
}

/** "'코카콜라 제로'라는 이름으로 우리 층 사람들에게 보여요. 내 이름은 안 보여요." */
export function previewSentence(name: string): string {
  return `'${name}'${hasFinalConsonant(name) ? '이라는' : '라는'} 이름으로 우리 층 사람들에게 보여요. 내 이름은 안 보여요.`;
}

/** "'코카콜라 제로 355'와 같아 보여요" */
export function sameItemHeadline(name: string): string {
  return `'${name}'${hasFinalConsonant(name) ? '과' : '와'} 같아 보여요`;
}

/** POST /api/pantry/draft 본문. 공통 검사로 가린 뒤의 글자예요. 저장하지 않아요. */
export interface PantryDraftRequest {
  text: string;
}

/** 게시 초안. 같은 품목 카드(먼저) 또는 공개 미리보기 카드, 담당 질문이면 [담당 찾기로 옮기기] 카드예요. */
export interface PantryDraftResponse {
  cards: Card[];
}

export interface BoardItem {
  /** 대표 카드 ID */
  bundleId: number;
  bundleVersion: number;
  name: string;
  /** 서로 다른 사람 수 */
  votes: number;
  myVote: boolean;
  catalogName: string | null;
  /** 합쳐진 다른 이름들(대표 이름 빼고) */
  mergedNames: string[];
  /** "같은 상품 같아요" 표시가 붙은 다른 품목 이름(확정 전, 표는 안 합쳐요) */
  similarTo: string[];
  /** 그 표시 중 실제 모델이 고른 것이 있는지("AI 정리"). 이름 규칙으로만 붙은 표시면 거짓이에요. */
  similarByAi: boolean;
  /** 지난 주기에서 넘어온 품목 */
  carriedOver: boolean;
}

export interface BoardResponse {
  floor: string;
  /** 총무만 여러 층을 골라요. 직원은 내 층 하나예요. */
  floors: string[];
  /** 내 층 판일 때만 표를 줄 수 있어요. */
  canVote: boolean;
  cycleNote: string;
  limit: number;
  /** 열린 묶음 중 내 표가 있는 묶음 수(모든 층) */
  myBundleCount: number;
  items: BoardItem[];
  lastCycle: { ordered: string[]; carriedOver: number };
}

export interface VoteRequest {
  bundleId: number;
}

export interface VoteResponse {
  bundleId: number;
  votes: number;
  myVote: boolean;
  /** 이번 요청으로 바뀐 게 있는지(이미 표가 있거나 없으면 false) */
  changed: boolean;
  myBundleCount: number;
  limit: number;
}

export const MY_REQUEST_STATUS = ['표 받는 중', '주문에 들어감', '다음 주기로 넘어감'] as const;
export type MyRequestStatus = (typeof MY_REQUEST_STATUS)[number];

export interface MyRequestItem {
  bundleId: number;
  name: string;
  floor: string;
  /** 주문에 들어간 품목은 표가 닫혀서 null이에요. */
  votes: number | null;
  status: MyRequestStatus;
}

export interface MyRequestsResponse {
  items: MyRequestItem[];
}

export interface SuggestionSide {
  bundleId: number;
  bundleVersion: number;
  name: string;
  votes: number;
  catalogName: string | null;
}

/** S4 합치기 제안함 한 줄(R15). 투표자는 없고 수만 있어요. */
export interface MergeSuggestion {
  a: SuggestionSide;
  b: SuggestionSide;
  /** 합친 뒤 표 수(서로 다른 사람 수) */
  votesAfter: number;
  /** 합치면 대표가 될 이름과 카탈로그 품목 */
  representativeName: string;
  catalogName: string | null;
  /** AI 정리인지, 이름 규칙인지 */
  source: 'ai' | 'rule';
}

export interface SuggestionsResponse {
  floor: string;
  suggestions: MergeSuggestion[];
}

export interface MergeRequest {
  /** 화면이 본 두 묶음(대표 카드 ID)과 묶음 버전 */
  bundleIds: [number, number];
  versions: [number, number];
}

export interface MergeResponse {
  bundleId: number;
  votes: number;
}

export interface KeepApartRequest {
  bundleIds: [number, number];
}

export interface MergeRecord {
  mergeId: number;
  mergedAt: string;
  /** 합칠 때 대표였던 이름 */
  representativeName: string;
  /** 합칠 때 묶인 이름 */
  mergedName: string;
  /** 지금 이 기록이 속한 묶음과 그 버전(되돌리기 충돌 검사용) */
  bundleId: number;
  bundleVersion: number;
}

export interface MergesResponse {
  floor: string;
  merges: MergeRecord[];
}

export interface RevertRequest {
  bundleVersion: number;
}

export interface FloorSetting {
  floor: string;
  minShareWon: number;
  perPersonLimit: number;
  /** 주기 마감 안내(표시용 글자) */
  cycleNote: string;
}

export interface PantrySettingsResponse {
  floors: FloorSetting[];
}

export type PantrySettingsUpdate = Omit<FloorSetting, 'floor'>;
