-- 결재 차례 알림(11/10 사용자 결정): 시연 가상 그룹웨어에 휴가 신청서가 올라오거나 팀장이 승인해서 차례가 넘어가면,
-- 그 차례인 사람(팀장 한 사람 또는 인사팀)에게 앱 알림이 가요. 누르면 가상 그룹웨어 결재함('groupware')이 열려요.
-- 알림 글에는 이름·날짜·종류·사유가 없어요. 운영(시연 아님)에는 가상 그룹웨어가 없어서 이 값의 알림도 생기지 않아요.
alter table notifications drop constraint notifications_page_check;
alter table notifications add constraint notifications_page_check
  check (page in ('home', 'navi', 'rooms', 'notices', 'board', 'mine', 'ops', 'chart', 'cafe', 'cafe-settle', 'groupware'));
