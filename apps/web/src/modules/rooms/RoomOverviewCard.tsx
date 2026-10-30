import type { RoomShowQuery } from '@one-line-desk/shared';
import { createContext, useContext, useState } from 'react';
import type { CardViewProps } from '../../components/CardView';
import { Icon } from '../../components/Icon';
import { KIND_TITLE } from '../../labels';
import { RoomDetail } from './RoomDetail';
import { statusText } from './roomText';

// 대화의 회의실 현황 카드(10/30 QA·디자인 회의). 회의실마다 누를 수 있는 한 줄이고, 누르면 회의실 자세히가 열려요.
// 예약은 자세히에서 확인 시트를 거쳐요(ADR-03). 한 줄에는 예약 버튼이 없어요. 머리 라벨은 "안내"예요.
// 처음엔 FIRST_ROWS줄만 보이고 [N곳 더 보기]로 이 카드 안에서 펼쳐요. 끝의 [그림으로 모든 회의실 보기]는 아래 "모든 회의실"을 같은 조건으로 펼쳐요.

const FIRST_ROWS = 5;

/** 회의실 채팅이 이 카드에 넘겨주는 것. 채팅 밖(시트 등)에서 그려지면 없어서 [그림으로 보기]를 숨겨요. */
export const RoomChatContext = createContext<{ showRooms: (show: RoomShowQuery) => void; canEditFacilities: boolean } | null>(null);

export function RoomOverviewCard({ card }: CardViewProps) {
  const chat = useContext(RoomChatContext);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const overview = card.overview;
  if (!overview) return null;
  const rows = all ? overview.rows : overview.rows.slice(0, FIRST_ROWS);
  const more = overview.rows.length - rows.length;

  return (
    <article className={`result-card label-${card.label} room-overview`} aria-label={`${KIND_TITLE[card.kind]} ${card.label}`}>
      <header className='card-head'>
        <span className='kind'>{KIND_TITLE[card.kind]}</span>
        <span className='label'>{card.label}</span>
      </header>
      <div className='card-body'>
        <p className='headline'>{card.headline}</p>
        {rows.length > 0 && (
          <ul className='room-rows' aria-label={card.headline}>
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type='button'
                  className='room-row'
                  onClick={() => setOpen(r.id)}
                  aria-label={`${r.name}, ${r.floor}${r.mine ? '(내 층)' : ''}, 정원 ${r.capacity}명, ${statusText(r.status)}${r.repairs ? ', 점검 중인 설비 있음' : ''}. 자세히 보기`}
                >
                  <span className='room-row-text'>
                    <span className='room-row-name'>
                      <strong>{r.name}</strong>
                      <span>
                        {r.floor} · {r.capacity}명
                      </span>
                      {r.mine && <span className='room-floor-mine'>내 층</span>}
                      {r.repairs && <span className='room-row-repair'>점검 중</span>}
                    </span>
                    <span className={`room-status ${r.status.kind}`}>{statusText(r.status)}</span>
                  </span>
                  <Icon name='chevron' size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {more > 0 && (
          <button type='button' className='link' onClick={() => setAll(true)}>
            {more}곳 더 보기
          </button>
        )}
      </div>
      <p className='evidence'>
        {card.evidence.aiSummarized && <span className='ai-badge'>AI 정리</span>}
        {card.evidence.text}
      </p>
      {chat && overview.rows.length > 0 && (
        <div className='card-actions'>
          <button type='button' className='secondary' onClick={() => chat.showRooms(overview.show)}>
            그림으로 모든 회의실 보기
          </button>
        </div>
      )}
      <p className='tail'>{card.tail}</p>

      {/* 물은 날짜로 열어요. 자세히는 열 때 최신 상태를 다시 불러와요(지난 현황 줄을 눌러도 지금 기준). */}
      {open && (
        <RoomDetail
          roomId={open}
          today={overview.today}
          initialDate={overview.date}
          canEditFacilities={chat?.canEditFacilities ?? false}
          onClose={() => setOpen(null)}
        />
      )}
    </article>
  );
}
