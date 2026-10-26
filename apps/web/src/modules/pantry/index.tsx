import type { ComponentType } from 'react';
import type { CardViewProps } from '../../components/CardView';
import type { ScreenProps } from '../types';
import { BoardScreen } from './BoardScreen';
import { MergePanel } from './MergePanel';
import { MyRequests } from './MyRequests';
import { OrderPanel } from './order';
import { BlockedCardView, PreviewCardView, SameItemCardView } from './PreviewCard';

// F3 같이 채워요 화면 부품. 판·게시·표·합치기는 같이 채워요 판 에이전트, S4 주문안은 주문안 에이전트(./order)가 채워요.

export { BoardScreen, MergePanel, MyRequests };

/** S4 총무 운영(PC 우선). 합치기 칸과 주문안 칸으로 나뉘어요. */
export function OpsScreen(props: ScreenProps) {
  return (
    <div className='ops'>
      <header className='screen-head'>
        <h1>총무 운영</h1>
      </header>
      <MergePanel {...props} />
      <OrderPanel {...props} />
    </div>
  );
}

export const pantryCardRenderers: Record<string, ComponentType<CardViewProps>> = {
  'pantry-preview': PreviewCardView,
  'pantry-same': SameItemCardView,
  'pantry-blocked': BlockedCardView,
};
