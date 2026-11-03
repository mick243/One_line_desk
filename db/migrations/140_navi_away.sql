-- 자리비움(11/3 사용자 결정, 홈 채팅 "같은 팀 일정"). 직원이 자기 외근·출장·재택·자리비움을 알려요.
-- 칸은 가명 ID·종류 코드·시작·끝뿐이에요. 자유 글(사유·장소) 칸은 없어요. 이름·부서도 넣지 않아요(보여 줄 때 디렉터리로 찾아요).
-- 정하기·지우기는 본인만, 고정 버튼(ctx.fixed.run)으로만 해요. 같은 부서 사람에게만 홈 채팅으로 보여요.
-- 기록 보관 7일(ADR-21): 정한 지 7일 지난 줄과 끝난 지 7일 지난 줄을 한 시간 보관 회차가 지워요(navi 모듈 retention).
create table navi_away (
  id bigserial primary key,
  pseudonym_id text not null,
  kind text not null check (kind in ('outside', 'trip', 'remote', 'away')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint navi_away_range check (ends_at > starts_at and ends_at - starts_at <= interval '8 days')
);
create index navi_away_who on navi_away (pseudonym_id, starts_at);
create index navi_away_created on navi_away (created_at);
create index navi_away_ends on navi_away (ends_at);
