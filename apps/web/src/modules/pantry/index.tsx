import type { ComponentType } from 'react';
import type { CardViewProps } from '../../components/CardView';
import { BoardScreen } from './BoardScreen';
import { MyRequests } from './MyRequests';
import { BlockedCardView, PreviewCardView, SameItemCardView } from './PreviewCard';

// F3 같이 채워요 화면 부품. 판·게시·표·합치기는 같이 채워요 판 에이전트, S4 주문안은 주문안 에이전트(./order)가 채워요.
// S4 총무 운영(./OpsScreen: 합치기·주문안)은 처음 열 때 따로 불러요. 여기서 내보내면 첫 화면에 같이 묶이니 내보내지 않아요.

export { BoardScreen, MyRequests };

export const pantryCardRenderers: Record<string, ComponentType<CardViewProps>> = {
  'pantry-preview': PreviewCardView,
  'pantry-same': SameItemCardView,
  'pantry-blocked': BlockedCardView,
};
