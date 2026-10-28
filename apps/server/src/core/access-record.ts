import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Queryable } from './db';

// 접속기록(ADR-20, 개인정보의 안전성 확보조치 기준 제8조). 감사 로그(core/audit.ts)와 따로 둬요.
// 칸: 시각·가명 ID·동작(정해진 코드)·처리한 정보주체 표시(가명 ID·문의 번호)·접속지(IP)·요청 번호. 글·검색어·이름은 받지 않아요.
// 접속지는 TRUST_PROXY가 관문 주소일 때의 req.ip예요. 관문이 X-Forwarded-For를 덮어써야 위조를 못 해요(망 회의 N-12).

/** 다른 사람의 개인정보를 보거나 바꾸는 동작과 로그인·로그아웃. 새 동작은 여기에 먼저 적어요. */
export const ACCESS_ACTIONS = ['login', 'logout', 'inquiry.inbox', 'inquiry.update', 'people.search'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** 1년 보관(제8조①). 정보주체 수가 많아 2년이 되면 CD-31 답에 따라 바꿔요. 006 마이그레이션의 트리거와 같은 값이에요. */
export const ACCESS_KEEP_MS = 365 * 24 * 60 * 60 * 1000;

const ALLOWED_KEYS = new Set(['pseudonymId', 'action', 'subjectRefs', 'ip', 'requestId']);
const REF = /^(inquiry|person|reservation):[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REFS = 100;

export interface AccessEntry {
  pseudonymId: string;
  action: AccessAction;
  /** "inquiry:12"·"person:p_ab12" 모양만 받아요. */
  subjectRefs?: string[];
  ip?: string;
  requestId?: string;
}

/** 요청에서 접속지·요청 번호를 꺼내요. */
export function accessFrom(req: FastifyRequest): Pick<AccessEntry, 'ip' | 'requestId'> {
  return { ip: req.ip, requestId: String(req.id) };
}

export class AccessRecorder {
  constructor(
    private readonly db: Queryable,
    private readonly now: () => number,
  ) {}

  /** tx 안에서 남기려면 q를 넘겨요. 정해진 칸·모양이 아니면 남기지 않고 던져요(내용이 새지 않게). */
  async record(entry: AccessEntry, q: Queryable = this.db): Promise<void> {
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_KEYS.has(key)) throw new Error(`접속기록에 없는 칸이에요: ${key}`);
    }
    if (!(ACCESS_ACTIONS as readonly string[]).includes(entry.action)) throw new Error('정해지지 않은 접속기록 동작이에요');
    const refs = entry.subjectRefs ?? [];
    if (refs.length > MAX_REFS || refs.some((r) => !REF.test(r))) throw new Error('정보주체 표시 모양이 틀렸어요');
    const ip = entry.ip && isIP(entry.ip) ? entry.ip : null;
    const requestId = entry.requestId && REQUEST_ID.test(entry.requestId) ? entry.requestId : null;
    await q.query('insert into access_log (at, pseudonym_id, action, subject_refs, client_ip, request_id) values ($1, $2, $3, $4, $5, $6)', [
      new Date(this.now()).toISOString(),
      entry.pseudonymId,
      entry.action,
      refs,
      ip,
      requestId,
    ]);
  }

  /** 보관 기간이 지난 줄만 지워요. 서버가 한 시간마다 불러요(L-33). */
  async purge(): Promise<void> {
    await this.db.query('delete from access_log where at < $1', [new Date(this.now() - ACCESS_KEEP_MS).toISOString()]);
  }
}
