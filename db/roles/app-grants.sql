-- 앱 계정 권한(11/11 QA Q5, 회사추가절차 2번). 마이그레이션 디렉터리 밖이라 자동으로 적용되지 않아요.
-- 표 주인은 소유자 계정(DESK_MIGRATE_DATABASE_URL, release_command만 써요)이고, 앱은 앱 계정(DATABASE_URL)으로만 붙어요.
-- 소유자 계정으로 마이그레이션을 처음 적용한 뒤 한 번 돌려요. 앞으로 소유자가 만드는 표에도 같은 권한이 붙어요(default privileges).
--   psql "$DESK_MIGRATE_DATABASE_URL" -v app_role=desk_app -f db/roles/app-grants.sql
-- 앱 계정은 표를 만들거나 바꾸거나 지우지 못해요(DDL 없음). TRUNCATE 권한도 없어요(행 트리거로는 TRUNCATE를 막지 못해요).
-- 접속기록(access_log, 1년, ADR-20)은 넣기·읽기와 1년 지난 줄 지우기(행 트리거가 1년 안 줄은 막아요)만이에요. 고치기 권한은 없어요.
-- 앱 계정 자체(로그인·비밀번호)는 관리형 DB 화면이나 CREATE ROLE로 먼저 만들어요. 비밀번호는 이 파일에 넣지 않아요.

grant usage on schema public to :"app_role";
grant select, insert, update, delete on all tables in schema public to :"app_role";
grant usage, select on all sequences in schema public to :"app_role";
grant execute on all functions in schema public to :"app_role";
revoke update on access_log from :"app_role";
revoke truncate, references, trigger on all tables in schema public from :"app_role";

alter default privileges in schema public grant select, insert, update, delete on tables to :"app_role";
alter default privileges in schema public grant usage, select on sequences to :"app_role";
alter default privileges in schema public grant execute on functions to :"app_role";
