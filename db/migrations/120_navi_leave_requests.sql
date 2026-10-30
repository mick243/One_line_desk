-- 휴가 요청·답장(10/30, ADR-24). 담당 팀 문의(navi_inquiries)에 휴가 요청 종류와 결정(승인·반려)을 더하고, 받은 팀의 답장을 둬요.
-- 7일이 지나면 지워요(ADR-21). 승인된 휴가는 우리 DB가 아니라 인사 근태 기록(어댑터)에 들어가요. 연차 숫자는 저장하지 않아요(ADR-18).

alter table navi_inquiries drop constraint navi_inquiries_state_check;
alter table navi_inquiries add constraint navi_inquiries_state_check check (state in ('new', 'seen', 'done', 'approved', 'rejected'));

alter table navi_inquiries add column kind text not null default 'general' check (kind in ('general', 'leave'));
-- 쓸 날 [{date, kind}]. 휴가 요청만 있어요.
alter table navi_inquiries add column leave_days jsonb;
-- 보낸 사람 IdP 주체. 휴가 요청만 있어요. 받은 팀이 그 사람 남은 연차를 계산하고 승인 때 근태 기록에 넣으려고 써요. 화면·LLM에는 내보내지 않아요.
alter table navi_inquiries add column sender_subject text;
alter table navi_inquiries add column decision_reason text check (decision_reason is null or char_length(decision_reason) between 1 and 500);
-- 승인했을 때 근태 기록에 넣었는지(근태 연결 안 함이면 false)
alter table navi_inquiries add column leave_recorded boolean;
alter table navi_inquiries add constraint navi_inquiries_leave_shape check (
  (kind = 'leave' and leave_days is not null and sender_subject is not null)
  or (kind = 'general' and leave_days is null and sender_subject is null)
);
-- 반려는 사유가 있어야 해요. 승인·반려는 휴가 요청만이에요.
alter table navi_inquiries add constraint navi_inquiries_decision_shape check (
  (state = 'rejected' and decision_reason is not null and kind = 'leave')
  or (state = 'approved' and kind = 'leave' and decision_reason is null)
  or (state in ('new', 'seen', 'done') and decision_reason is null)
);

create table navi_inquiry_replies (
  id bigserial primary key,
  inquiry_id bigint not null references navi_inquiries (id) on delete cascade,
  -- 답장한 사람(받은 팀). 보낸 사람 화면에 이름이 보여요.
  author_pseudonym text not null,
  author_name text not null,
  body text not null check (char_length(body) between 1 and 1000),
  request_id text not null,
  created_at timestamptz not null default now(),
  unique (inquiry_id, request_id)
);
create index navi_inquiry_replies_inquiry on navi_inquiry_replies (inquiry_id, created_at);
create index navi_inquiry_replies_created on navi_inquiry_replies (created_at);
