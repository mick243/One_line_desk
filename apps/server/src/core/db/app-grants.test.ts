import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GRANT_CHECK_SQL, type GrantCheckRow, grantProblems, grantsSql } from '../../../scripts/tenant-lib';
import { applyMigrations } from './migrate';
import { createPgliteDb } from './pglite';

// 앱 계정 권한(11/11 QA Q5): 소유자(마이그레이션) 계정이 표 주인이고, 앱 계정은 db/roles/app-grants.sql 권한만 가져요.
// 행 트리거는 TRUNCATE를 막지 못해서, 앱 계정에 TRUNCATE·DDL 권한이 없어야 접속기록(1년, ADR-20)이 지켜져요.

const GRANTS = fileURLToPath(new URL('../../../../../db/roles/app-grants.sql', import.meta.url));
/** psql 변수(:"app_role")를 시험 역할 이름으로 바꿔요. */
const grantsFor = (role: string) => readFileSync(GRANTS, 'utf8').replaceAll(':"app_role"', `"${role}"`);

describe('앱 계정 권한(db/roles/app-grants.sql)', () => {
  it('[QA Q5 시험] 앱 계정은 넣기·읽기는 되고, 접속기록 TRUNCATE·고치기와 표 만들기·지우기는 못 해요', async () => {
    const db = await createPgliteDb();
    try {
      await applyMigrations(db);
      await db.exec('create role desk_app_test nologin');
      await db.exec(grantsFor('desk_app_test'));
      await db.exec('set role desk_app_test');
      // 앱이 하는 일: 넣기·읽기·고치기(일반 표)
      await db.query("insert into access_log (at, pseudonym_id, action) values (now(), 'p_test', 'test.read')");
      expect((await db.query('select count(*)::int as n from access_log')).rows).toEqual([{ n: 1 }]);
      await db.query("insert into ai_usage (module, purpose, provider, ok) values ('router', 'classify', 'fake', true)");
      await db.query('update ai_usage set ok = false');
      // 못 하는 일
      await expect(db.exec('truncate access_log')).rejects.toThrow(/permission denied/);
      await expect(db.exec("update access_log set action = 'x'")).rejects.toThrow(/permission denied/);
      await expect(db.exec('truncate ai_usage')).rejects.toThrow(/permission denied/);
      await expect(db.exec('drop table access_log')).rejects.toThrow(/must be owner|permission denied/);
      await expect(db.exec('create table sneaky (id int)')).rejects.toThrow(/permission denied/);
      await db.exec('reset role');
      // 소유자가 나중에 만든 표에도 같은 권한이 붙어요(default privileges).
      await db.exec('create table later_table (id int)');
      await db.exec('set role desk_app_test');
      await db.query('insert into later_table values (1)');
      await expect(db.exec('truncate later_table')).rejects.toThrow(/permission denied/);
    } finally {
      await db.close();
    }
  });

  it('[11/25 tenant 배포 전 확인] 권한 SQL을 돌린 앱 계정은 문제 0건이고, 권한 전·소유자 계정·표 없음은 각각 멈출 까닭이 나와요', async () => {
    const db = await createPgliteDb();
    const check = async () => grantProblems((await db.query<GrantCheckRow>(GRANT_CHECK_SQL)).rows[0]!);
    try {
      expect(await check()).toEqual(['표가 없어요. db-init(마이그레이션 → 권한)을 먼저 돌려 주세요']);
      await applyMigrations(db);
      // 시험 DB의 기본 계정은 표 주인이에요(소유자 주소를 DATABASE_URL에 잘못 넣은 경우).
      expect((await check()).join('\n')).toContain('표 주인');
      await db.exec('create role desk_app_check nologin');
      await db.exec('set role desk_app_check');
      expect((await check()).join('\n')).toContain('넣지 못해요');
      await db.exec('reset role');
      await db.exec(grantsSql(readFileSync(GRANTS, 'utf8'), 'desk_app_check'));
      await db.exec('set role desk_app_check');
      expect(await check()).toEqual([]);
      await db.exec('reset role');
      await db.exec('grant truncate on access_log to desk_app_check');
      await db.exec('set role desk_app_check');
      expect(await check()).toEqual(['앱 계정에 TRUNCATE 권한이 있어요(없어야 해요)']);
    } finally {
      await db.close();
    }
  });

  it('앱 계정 이름은 SQL에 그대로 들어가서 영문 소문자·숫자·밑줄만 받아요', () => {
    expect(grantsSql(':"app_role"', 'desk_app')).toBe('"desk_app"');
    expect(() => grantsSql(':"app_role"', 'x"; drop table access_log; --')).toThrow();
  });
});
