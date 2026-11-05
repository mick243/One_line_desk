import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLeaveRecords, MockLeave } from './leave';

// 회사별 가상 근태 기록 파일(11/5, 회사별 분리 시험). 다른 회사 가상 직원의 기록을 저장소 밖 파일에서 읽어요.
describe('가상 근태 기록 파일', () => {
  it('파일의 기록만 보고, 앱에 든 가상 직원 기록은 보지 않아요. 모양이 틀리면 띄우지 않아요', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-leave-'));
    const file = join(dir, 'b.json');
    writeFileSync(file, JSON.stringify({ 'boram@company-b.example': { hireDate: '2021-04-01', uses: [{ date: '2026-10-02', kind: 'full' }] } }));
    const leave = new MockLeave(loadLeaveRecords(file));
    expect(await leave.leaveOf({ idpSubject: 'x', email: 'boram@company-b.example' })).toEqual({
      hireDate: '2021-04-01',
      uses: [{ date: '2026-10-02', kind: 'full' }],
    });
    expect(await leave.leaveOf({ idpSubject: 'x', email: 'haneul@corp.example' })).toBeNull();
    writeFileSync(file, JSON.stringify({ 'boram@company-b.example': { hireDate: '어제', uses: [] } }));
    expect(() => loadLeaveRecords(file)).toThrow();
  });
});
