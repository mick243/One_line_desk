import { describe, expect, it } from 'vitest';
import { assertLeaveDraftPayload } from './groupware-draft';

// 그룹웨어 기안 어댑터 계약(11/6, ADR-24 보강): 상신만·승인 칸 금지·멱등 키·오류 글에 값 없음.
describe('[ADR-24 시험] 그룹웨어 기안 몸통 계약', () => {
  const key = 'leave-0f1e2d3c4b5a';
  const ok = { type: 'annual', from: '2026-11-13', to: '2026-11-13', reason: '가상 사유', status: 'requested' };

  it('상신 상태의 기본 몸통은 통과해요', () => {
    expect(() => assertLeaveDraftPayload(ok, key)).not.toThrow();
    expect(() => assertLeaveDraftPayload({ type: 'sick', days: [{ date: '2026-11-13', half: 'am' }] }, key)).not.toThrow();
  });

  it('승인 상태로 보내면 막아요', () => {
    expect(() => assertLeaveDraftPayload({ ...ok, status: 'approved' }, key)).toThrow(/상태는 상신·요청만/);
  });

  it('결재 건너뛰기·자동 승인·승인자·결재선 칸은 어디에 있어도 막아요', () => {
    for (const bad of [
      { ...ok, skip_approval: true },
      { ...ok, autoApprove: true },
      { ...ok, approver_id: 'x' },
      { ...ok, meta: { approvalLine: ['x'] } },
      { ...ok, items: [{ approved_by: 'x' }] },
      { ...ok, 결재선: ['x'] },
    ])
      expect(() => assertLeaveDraftPayload(bad as Record<string, unknown>, key)).toThrow(/승인·결재선 칸/);
  });

  it('멱등 키가 없으면 막아요', () => {
    expect(() => assertLeaveDraftPayload(ok, '')).toThrow(/멱등 키/);
  });

  it('오류 글에는 칸 이름만 있고 값(사유)은 없어요', () => {
    const canary = '카나리-사유-9f3a';
    try {
      assertLeaveDraftPayload({ ...ok, reason: canary, status: 'approved' }, key);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(canary);
    }
  });
});
