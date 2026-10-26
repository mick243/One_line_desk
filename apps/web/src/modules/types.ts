import type { Card, Kind } from '@one-line-desk/shared';
import type { ComponentType } from 'react';
import type { Me } from '../api';
import type { CardViewProps } from '../components/CardView';

// 모듈 화면 부품 약속. 공통 화면(S1·S2·S6)은 이 부품을 끼워 그려요.

/** "틀렸어요" 시트(R8). 담당 모듈이 만들어요. */
export interface WrongSheetProps {
  card: Card;
  /** [종류가 달라요]를 고르면 같은 문장으로 그 종류를 다시 불러요. 문장은 묻기 화면 메모리에 있어요. */
  onReask: (kind: Kind) => void;
  /** [다른 담당이에요]에서 고른 행 카드로 결과 시트의 카드를 바꿔요. */
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
      /** 판에 담당 질문을 쓰면 [묻기로 옮기기]. 글은 앱 메모리로만 넘겨요(F3-4). */
      onMoveToAsk: (text: string) => void;
    }
  >;
  /** S4 총무 운영 */
  OpsScreen: ComponentType<ScreenProps>;
  /** S5 분장표 수정 제안함 */
  ChartScreen: ComponentType<ScreenProps>;
  /** S1·S6 "내 예약" 칸 */
  MyReservations: ComponentType<{ compact?: boolean }>;
  /** S1·S6 "내 요청" 칸 */
  MyRequests: ComponentType<{ compact?: boolean }>;
  /** S6 "연결된 AI 앱" 칸 */
  ConnectedApps: ComponentType;
  /** /oauth/consent: 사내 로그인 뒤 S6 위에 뜨는 MCP 연결 동의 시트(M4) */
  ConsentScreen: ComponentType<ScreenProps>;
  /** /r/<토큰>: MCP 결과의 앱 확인 링크로 들어온 S2(M3) */
  LinkEntry: ComponentType<ScreenProps & { token: string }>;
}
