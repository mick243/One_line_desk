// F1 담당 안내 화면 부품: 문의 양식·받은 문의함과 S5 분장표 수정 제안함(R9). 11/2 "틀렸어요" 시트는 뺐어요(ADR-26).
// 담당·공지 카드는 공통 CardView가 그려요. 문의 보내기 양식·받은 문의함·내 문의(ADR-16)도 여기서 내보내요.
// 분장표 수정 제안함(./ChartScreen)·IT 오류(./ItHelpScreen)·첫 2주(./OnboardingScreen)·휴가 신청(./LeaveRequestSheet)은
// 처음 열 때 따로 불러요(registry의 lazyPart). 여기서 내보내면 첫 화면에 같이 묶이니 내보내지 않아요.
export { InquiryInbox, MyInquiries } from './Inquiries';
export { InquirySheet } from './InquirySheet';
