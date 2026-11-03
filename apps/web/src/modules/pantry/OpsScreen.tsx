import type { ScreenProps } from '../types';
import { MergePanel } from './MergePanel';
import { OrderPanel } from './order';

// S4 총무 운영 화면. 총무만 열어서 처음 열 때 따로 불러요(registry의 lazyPart). index에서 다시 내보내지 마세요(첫 화면에 같이 묶여요).

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
