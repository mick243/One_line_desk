import type { Card, CardAction, Kind, RoomShowQuery } from '@one-line-desk/shared';
import type { ComponentType } from 'react';
import type { Me } from '../api';
import type { CardViewProps } from '../components/CardView';

// 모듈 화면 부품 약속. 홈·기능 페이지·마이 페이지는 이 부품을 끼워 그려요.

/** "틀렸어요" 시트(R8). 담당 모듈이 만들어요. */
export interface WrongSheetProps {
  card: Card;
  /** [종류가 달라요]를 고르면 같은 문장을 그 기능 페이지로 옮겨요. 문장은 페이지 메모리에 있어요. */
  onReask: (kind: Kind) => void;
  /** [다른 담당이에요]에서 고른 행 카드로 페이지의 카드를 바꿔요. */
  onReplace?: (card: Card) => void;
  onClose: () => void;
}

export interface ScreenProps {
  me: Me;
}

export interface WebModules {
  /** card.variant → 따로 그리는 카드(예: 'pantry-preview') */
  cardRenderers: Record<string, ComponentType<CardViewProps>>;
  WrongSheet: ComponentType<WrongSheetProps>;
  /** S3 같이 채워요 판 */
  BoardScreen: ComponentType<
    ScreenProps & {
      onOpenOps: () => void;
      /** 판에 담당 질문을 쓰면 [담당 찾기로 옮기기]. 글은 앱 메모리로만 넘겨요(F3-4). */
      onMoveToNavi: (text: string) => void;
      /** 홈 예시 문장·다른 페이지에서 옮겨 온 글. 요청 쓰기 칸에 채워만 둬요. */
      initialText?: string;
      /** 머리 글과 입력 칸 문구(screens/features.ts의 같이 채워요 줄) */
      head: { question: string; summary: string; placeholder: string; submit: string };
    }
  >;
  /** S4 총무 운영 */
  OpsScreen: ComponentType<ScreenProps>;
  /** S5 분장표 수정 제안함 */
  ChartScreen: ComponentType<ScreenProps>;
  /** 담당 찾기 아래: IT 오류 문장 → IT FAQ 원문 단계(10/31 넓힐 후보 ②) */
  ItHelpScreen: ComponentType<{ onBack: () => void }>;
  /** 담당 찾기 아래: 신규 입사자 첫 2주 할 일(10/31 넓힐 후보 ①) */
  OnboardingScreen: ComponentType<{ onBack: () => void }>;
  /** 담당 팀에 문의 보내기 양식(ADR-16). 담당 카드의 [○○에 문의하기]로 열려요. */
  InquirySheet: ComponentType<{ action: Extract<CardAction, { type: 'inquire' }>; initialQuestion: string; onClose: () => void }>;
  /** 휴가 신청 양식(ADR-24). 연차 카드의 [휴가 신청하기]로 열려요. 보내기는 확인 시트를 거쳐요. */
  LeaveRequestSheet: ComponentType<{ action: Extract<CardAction, { type: 'leave-request' }>; onClose: () => void }>;
  /** 담당 찾기 페이지: 우리 팀에 온 문의(받은 문의함) */
  InquiryInbox: ComponentType;
  /** 담당 찾기 페이지: 내가 보낸 문의와 처리 상태 */
  MyInquiries: ComponentType;
  /** 회의실 페이지 "모든 회의실": 회의실 카드(그림·정원·상태) → 회의실 자세히(설비·하루 일정·이 시간 예약) */
  /** 모든 회의실. 회의실 카드는 대화에서 현황을 물었을 때(show)만 펼쳐요(10/30). */
  RoomDirectory: ComponentType<ScreenProps & { show?: RoomShowQuery | null }>;
  /** 회의 참석자 고르기 양식(ADR-17). 확정 카드·내 예약의 [참석자 초대]로 열려요. */
  InviteSheet: ComponentType<{ action: Extract<CardAction, { type: 'invite' }>; onClose: () => void }>;
  /** 회의실·마이 페이지의 "나를 부른 회의" 칸 */
  InvitedMeetings: ComponentType;
  /** 마이 페이지의 시연 받은편지함(모의 그룹웨어 캘린더·모의 Slack) */
  DemoInbox: ComponentType;
  /** 홈·회의실·마이 페이지의 "내 예약" 칸 */
  MyReservations: ComponentType<{ compact?: boolean }>;
  /** 회의실 페이지 "내 대여" 칸(ADR-19) */
  MyLoans: ComponentType;
  /** 회의실 페이지 채팅: 시키면 바로 예약·대여, 물으면 카드(ADR-19). auto는 채팅 자동 실행이 켜졌는지예요. */
  RoomChat: ComponentType<{
    auto: boolean;
    write: boolean;
    initialText?: string;
    autoRun?: boolean;
    onMove?: (kind: Kind, text: string) => void;
    /** 최근 쓴 문장(이 창 메모리에만). 칩의 [×]로 하나씩 지워요. */
    recent?: string[];
    onSent?: (text: string) => void;
    onRemoveRecent?: (text: string) => void;
    /** 현황 카드의 [그림으로 모든 회의실 보기]가 아래 회의실 카드를 펼쳐요. null이면 접어요. */
    onShowRooms?: (show: RoomShowQuery | null) => void;
    /** 현황 줄로 연 회의실 자세히에서 설비 상태를 바꿀 수 있는지(총무) */
    canEditFacilities?: boolean;
  }>;
  /** 홈·마이 페이지의 "내 요청" 칸 */
  MyRequests: ComponentType<{ compact?: boolean }>;
  /** S6 "연결된 AI 앱" 칸 */
  ConnectedApps: ComponentType;
  /** /oauth/consent: 사내 로그인 뒤 S6 위에 뜨는 MCP 연결 동의 시트(M4) */
  ConsentScreen: ComponentType<ScreenProps>;
  /** /r/<토큰>: MCP 결과의 앱 확인 링크로 들어온 S2(M3) */
  LinkEntry: ComponentType<ScreenProps & { token: string }>;
}
