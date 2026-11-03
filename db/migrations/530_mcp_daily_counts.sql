-- MCP 월간 보고용 날마다 셈(11/3 사용자 결정, ADR-21 예외 · ADR-15 관리 평면 1단계).
-- 감사 로그는 7일만 남아서(ADR-21) 달 보고를 감사 로그로 셀 수 없어요. 그래서 감사 로그를 남기는 그 자리에서 셈만 +1 해요.
-- 칸: 날(한국 시간)·종류(정해진 코드)·앱 이름(운영자가 등록한 이름, 모르면 '-')·수. 사람·가명 ID·클라이언트 ID·도구 입력 칸은 없어요.
-- 13개월(이번 달 + 지난 12달)이 지난 날은 mcp 모듈 retention이 한 시간마다 지워요. 코드 목록은 modules/mcp/counts.ts와 같아요.
create table mcp_daily_counts (
  day date not null,
  kind text not null check (
    kind in (
      'call.found',
      'call.none',
      'call.refused',
      'call.error',
      'connect',
      'connect.denied',
      'disconnect',
      'disconnect.ops',
      'token.refused',
      'authorize.blocked',
      'employment.ended'
    )
  ),
  app text not null check (char_length(app) between 1 and 40),
  count integer not null check (count >= 0),
  constraint mcp_daily_counts_pkey primary key (day, kind, app)
);
