// 홈: 무엇을 할 수 있는지 목록 하나로 보여 줘요(10/26 화면 구조 변경, 10/26 디자인 정리).
// 한 줄을 누르면 그 기능 페이지가 열려요. 아래에는 다가오는 내 예약·내 요청이 있어요.
import type { AppDestination, ModuleKind, ModuleSwitch } from '@one-line-desk/shared';
import type { Me } from '../api';
import { Icon } from '../components/Icon';
import { webModules } from '../modules/registry';
import { FEATURES, featureFor } from './features';

const ICON = { navi: 'navi', rooms: 'rooms', notices: 'notices', pantry: 'pantry' } as const;

export function Home({
  me,
  switches,
  onOpen,
}: {
  me: Me;
  switches: { modules: Record<ModuleKind, ModuleSwitch>; roomsWrite: boolean; autoActions: boolean };
  onOpen: (page: AppDestination, text?: string) => void;
}) {
  const { MyReservations, MyRequests } = webModules;
  const { modules } = switches;
  const features = FEATURES.filter((f) => modules[f.module] !== 'off').map((f) => featureFor(f, switches));

  return (
    <div className='home'>
      <header className='page-head'>
        <p className='eyebrow'>
          {me.department} · {me.floor}
        </p>
        <h1>
          {me.displayName}님,
          <br />
          무엇을 할까요?
        </h1>
      </header>

      <section className='card' aria-label='할 수 있는 일'>
        <ul className='menu-list'>
          {features.map((f) => (
            <li key={f.page}>
              <button type='button' className='menu-row' onClick={() => onOpen(f.page)}>
                <span className={`menu-icon tint-${f.module}`}>
                  <Icon name={ICON[f.module]} />
                </span>
                <span className='menu-text'>
                  <strong>{f.title}</strong>
                  <span>{f.short}</span>
                </span>
                <span className='chevron'>
                  <Icon name='chevron' size={20} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {modules.rooms !== 'off' && <MyReservations compact />}
      {modules.pantry !== 'off' && <MyRequests compact />}
    </div>
  );
}
