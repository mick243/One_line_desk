import type { Card, ModuleKind, OpsSettings, PlanSheet, Slots } from '@one-line-desk/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { AdapterCapabilities } from '../adapters/types';
import type { Queryable } from './db';
import type { DeskUser } from './user';

// 모듈 약속(ADR-01). 모듈은 자기 표와 쓰기 경로만 갖고, 다른 모듈은 import하지 않아요.
// 다른 모듈 기능이 필요하면 ctx.services(core/services.ts)를 거쳐요.

export interface AskInput {
  /** 공통 검사를 지나고 가린 뒤의 문장. 저장하지 않아요. */
  text: string;
  slots: Slots;
  /** 슬롯을 모델이 뽑았는지. 거절·실패·가짜 공급자면 규칙으로 뽑은 거라 거짓이에요("AI 정리" 표시에 써요). */
  aiParsed: boolean;
  user: DeskUser;
}

export interface AskOutcome {
  cards: Card[];
  /** 근거를 찾았는지. 감사 로그 결과(카드 만듦/못 찾음)에만 써요(R11). */
  found: boolean;
}

export type ExecOutcome = { status: 'done'; card: Card } | { status: 'blocked'; card: Card; alternatives?: Card[] };

export interface ExecContext {
  /** 이 plan의 트랜잭션. 모든 쓰기는 이걸로 해요. */
  q: Queryable;
  user: DeskUser;
  planId: string;
  now: number;
}

/**
 * plan 처리기(ADR-03). 쓰기 한 종류마다 하나예요.
 * - propose 흐름: 카드 주 버튼 → sheet()로 확인 시트 → 확인 → execute()
 * - direct 흐름(게시): 공개 미리보기 [올리기] → 바로 execute()
 * - auto 흐름(채팅 명령, ADR-19): autoAllowed 처리기만, 사람이 채팅으로 직접 시킨 명령 → 바로 execute()
 */
export interface PlanHandler<P> {
  module: ModuleKind;
  action: string;
  /** 토큰 안 값(과 사용자가 고친 값)을 검증해요. */
  schema: z.ZodType<P>;
  /** 공개 미리보기에서 사용자가 고칠 수 있는 칸 */
  editableKeys?: string[];
  /** 채팅 자동 실행 허용 목록(ADR-19). 참이면 사람이 채팅으로 직접 시킨 명령을 확인 시트 없이 PlanService.auto로 실행해요. */
  autoAllowed?: boolean;
  sheet?(params: P, user: DeskUser): Promise<PlanSheet>;
  /** 확인 순간 다시 검사하고 실행해요. 겹침은 막힘으로 돌려줘요(R5). */
  /** 트랜잭션 ex.q 안에서 쓰기만 해요. 여기서 LLM(ctx.gateway)을 부르지 않아요. 게이트웨이가 ctx.db에 비용 행을 써서 PGlite(연결 하나)에서는 서로 기다리다 멈춰요. AI 판단은 제안 때 해서 토큰에 담아요. */
  execute(params: P, ex: ExecContext): Promise<ExecOutcome>;
  /** 만료된 제안을 같은 조건으로 다시 찾아요. 게시는 고친 이름으로 새 미리보기를 줘요. */
  reSearch?(params: P, user: DeskUser): Promise<Card[]>;
  /** 실행해도 되는 스위치 상태인지. 기본은 모듈 스위치가 'on'이에요. */
  enabled?(settings: OpsSettings): boolean;
  /** 실행 뒤 plan 행에 남길 매개변수. 막힌 이름처럼 남기면 안 되는 값은 빼요(R13). 기본은 그대로예요. */
  storedParams?(params: P, outcome: ExecOutcome): unknown;
}

export interface DeskModule {
  readonly kind: ModuleKind | 'mcp';
  /** 앞문 라우터가 이 종류로 보낼 때 카드를 만들어요. 읽기만 해요. */
  ask?(input: AskInput): Promise<AskOutcome>;
  /** 메서드 매개변수는 서로 바꿔 쓸 수 있어서 PlanHandler<RoomParams>도 여기에 들어가요. */
  planHandlers?: PlanHandler<unknown>[];
  /** 모듈 경로를 붙여요. */
  register?(app: FastifyInstance): void;
  /** 비어 있는 DB에 가상 자료(등급 0)를 넣어요. 여러 번 불러도 한 번만 들어가야 해요. */
  seed?(): Promise<void>;
  /** "시연 데이터로 돌아가요" 띠에 보여 줄 어댑터 */
  adapters?(): AdapterCapabilities[];
  /** 보관 기간이 지난 자기 표의 행을 지워요. 서버가 정해진 시각마다 불러요(L-33). */
  retention?(): Promise<void>;
}
