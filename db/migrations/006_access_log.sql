-- 접속기록(10/28, ADR-20). 개인정보의 안전성 확보조치 기준 제8조: 누가·언제·어디서(접속지)·무엇을·누구의 정보를 처리했는지 남겨요.
-- 감사 로그(audit_log)와 따로예요. 감사 로그는 내용 없이 동작 종류만, 여기는 법이 요구하는 접속지(IP)와 처리한 정보주체 표시(가명 ID·문의 번호)를 남겨요.
-- 글·검색어·이름은 넣지 않아요(core/access-record.ts가 정해진 칸만 받아요). 고칠 수 없고, 보관 기간(1년)이 지난 줄만 지울 수 있어요.
-- 운영 DB에서는 앱 계정에 INSERT·SELECT와 1년 지난 줄 DELETE만 줘요(L-21). 아래 트리거는 그 권한과 따로 한 번 더 막아요.
create table access_log (
  id bigserial primary key,
  at timestamptz not null,
  pseudonym_id text not null,
  action text not null,
  subject_refs text[] not null default '{}',
  client_ip inet,
  request_id text
);
create index access_log_at on access_log (at);
create index access_log_who on access_log (pseudonym_id, at);

create function access_log_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'access log rows cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  if old.at > now() - interval '365 days' then
    raise exception 'access log rows are kept for a year' using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$$;

create trigger access_log_no_change
  before update or delete on access_log
  for each row execute function access_log_guard();
