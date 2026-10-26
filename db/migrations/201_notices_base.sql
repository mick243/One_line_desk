-- 공지 찾기(ADR-09·14, M6). 허용 게시판 사본의 색인만 둬요.
-- 본문은 저장하지 않고 검색용 두 글자 조각(terms)만 남겨요. 화면·API·MCP로는 제목·게시일·원문 링크만 나가요.
create table notices (
  id text primary key,
  board text not null,
  title text not null check (char_length(title) between 1 and 200),
  posted_on date not null,
  url text not null check (url ~ '^https?://'),
  terms text[] not null default '{}'
);
create index notices_terms on notices using gin (terms);
create index notices_board on notices (board);
