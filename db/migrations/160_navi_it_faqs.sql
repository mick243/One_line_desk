-- IT FAQ(10/31 넓힐 후보 ②). 붙여 넣은 IT 오류 문장에 맞는 FAQ를 찾아 원문 단계를 그대로 보여 줘요.
-- 기준 자료라 7일 지우기 대상이 아니에요. 사람 이름 칸은 없어요. 붙여 넣은 오류 문장은 어디에도 저장하지 않아요(ADR-10).
-- row_id: 해결이 안 될 때 문의를 보내는 분장표 행(IT지원팀). source는 분장표와 같은 뜻이에요(demo/upload).
create table navi_it_faqs (
  id text primary key check (id ~ '^ITF-[0-9]{2,3}$'),
  title text not null check (char_length(title) between 1 and 80),
  aliases text[] not null default '{}',
  error_codes text[] not null default '{}',
  steps text[] not null check (cardinality(steps) between 1 and 12),
  revised_on date not null,
  row_id text references navi_rows (id) on delete set null,
  source text not null default 'upload' check (source in ('demo', 'upload'))
);
