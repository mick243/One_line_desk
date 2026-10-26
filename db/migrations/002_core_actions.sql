-- 공통: 쓰기 영수증(멱등 키, ADR-03). 같은 키가 다시 오면 저장한 결과만 돌려줘요.
create table action_receipts (
  idempotency_key text primary key,
  pseudonym_id text not null,
  module text not null,
  action text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

-- plan 결과 카드(JSON)를 담아 같은 plan_id 확인이 다시 와도 결과만 돌려줘요.
alter table plans add column result jsonb;

-- AI 비용 집계(본문 없음, ADR-10 운영 표).
create table ai_usage (
  id bigserial primary key,
  at timestamptz not null default now(),
  module text not null,
  purpose text not null,
  provider text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  ok boolean not null
);
