-- 모의 그룹웨어 캘린더·모의 Slack(10/26, ADR-17). 실제 서비스 대신 시연에서 무엇이 나갔는지 보여 줘요.
-- 가상 직원 메일만 들어가요. 실제 그룹웨어·Slack 어댑터를 쓰면 이 표는 비어 있어요.
create table mock_calendar_events (
  uid text primary key,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text not null,
  organizer_email text not null,
  attendee_emails text[] not null default '{}',
  cancelled boolean not null default false,
  updated_at timestamptz not null
);

create table mock_messenger_messages (
  id bigserial primary key,
  to_email text not null,
  text text not null,
  sent_at timestamptz not null
);
create index mock_messenger_messages_to on mock_messenger_messages (to_email, sent_at desc);
