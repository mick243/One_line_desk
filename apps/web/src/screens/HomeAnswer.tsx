// 홈 AI 채팅 답(ADR-27)을 그리는 부품. 상태가 없어서 시험에서 바로 그려 봐요.
// 항목마다 그 기능 페이지로 가는 버튼만 있어요. 쓰기 버튼(예약·신청·참석 답)은 홈에 없어요(D8 조건).
// 같은 팀 일정(11/3)은 이름·날과 휴가(하루/오전/오후)·회의(시간·회의실)·자리비움(종류·시간)만 그려요. 버튼이 없고,
// 휴가 종류·사유·회의 참석자 칸은 응답에도 없어요.
import {
  ABSENCE_PART_LABEL,
  AWAY_KIND_LABEL,
  dayLabel,
  type HomeAskResponse,
  type HomeItem,
  type HomeOpen,
  type HomeTeamSchedule,
  TEAM_SCHEDULE_TEXT,
  type TeamEntry,
} from '@one-line-desk/shared';
import type { ReactNode } from 'react';

export function HomeItemList({ items, onOpen, label }: { items: HomeItem[]; onOpen: (open: HomeOpen) => void; label: string }) {
  return (
    <ul className='home-items' aria-label={label}>
      {items.map((i) => (
        <li key={i.id}>
          <div className='home-item-text'>
            <strong>{i.title}</strong>
            <span className='hint'>
              {i.when}
              {i.detail ? ` · ${i.detail}` : ''}
            </span>
          </div>
          <button type='button' className='secondary small' onClick={() => onOpen(i.open)}>
            {i.open.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

const entryText = (e: TeamEntry) =>
  e.what === 'leave'
    ? `${ABSENCE_PART_LABEL[e.part]} 부재`
    : e.what === 'meeting'
      ? `${e.start}–${e.end} 회의(${e.room})`
      : e.allDay
        ? `종일 ${AWAY_KIND_LABEL[e.away]}`
        : `${e.start}–${e.end} ${AWAY_KIND_LABEL[e.away]}`;

/** 같은 팀 일정 목록. 하루만 물었으면 머리 줄에 이미 다 있어서 여러 날일 때만 날짜별로 그려요. */
function TeamScheduleList({ team, oneDay }: { team: HomeTeamSchedule; oneDay: boolean }) {
  if (!team.shown) return null;
  return (
    <div className='home-team'>
      {!oneDay && team.entries.length > 0 && (
        <ul className='home-items' aria-label={`${team.team} 일정`}>
          {team.entries.map((e, i) => (
            <li key={`${e.date}-${i}`}>
              <div className='home-item-text'>
                <strong>{e.name}</strong>
                <span className='hint'>
                  {dayLabel(e.date)} · {entryText(e)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!team.leaveConnected && <p className='hint'>{TEAM_SCHEDULE_TEXT.leaveMissing}</p>}
      <p className='hint'>{TEAM_SCHEDULE_TEXT.tail}</p>
    </div>
  );
}

/** 답 하나. 내 일이면 한 줄 + 목록 + 바로 가기 버튼, 옮기기·모름이면 카드(cards)만 그려요. "AI 정리"는 실제 모델이 해석했을 때만 붙어요. */
export function HomeAnswer({ answer, onOpen, cards }: { answer: HomeAskResponse; onOpen: (open: HomeOpen) => void; cards?: ReactNode }) {
  return (
    <div className='home-answer'>
      {(answer.intent === 'mine' || answer.intent === 'team-schedule') && (
        <p className='chat-bubble'>
          {answer.headline}
          {answer.by === 'ai' && <span className='chat-ai'>AI 정리</span>}
        </p>
      )}
      {answer.team && <TeamScheduleList team={answer.team} oneDay={answer.period === 'today' || answer.period === 'tomorrow'} />}
      {answer.items.length > 0 && <HomeItemList items={answer.items} onOpen={onOpen} label={answer.headline} />}
      {(answer.links.length > 0 || answer.team?.link) && (
        <div className='home-links'>
          {answer.links.map((l) => (
            <button key={l.text} type='button' className='secondary small' onClick={() => onOpen(l)}>
              {l.text}
            </button>
          ))}
          {answer.team?.link && (
            <a className='secondary small' href={answer.team.link} target='_blank' rel='noopener noreferrer'>
              그룹웨어 팀 일정 열기
            </a>
          )}
        </div>
      )}
      {cards}
    </div>
  );
}

export interface HomeTurn {
  id: number;
  /** 가린 뒤의 질문 글. 이 창 메모리에만 있어요(브라우저 저장소·주소에 넣지 않아요, R13). */
  text: string;
  answer?: HomeAskResponse;
  lines?: string[];
  retry?: boolean;
}

/** 최근 대화 몇 개만 둬요. 새 것이 위예요. */
export const HOME_TURNS_MAX = 5;
export function pushTurn(list: HomeTurn[], turn: HomeTurn): HomeTurn[] {
  return [turn, ...list].slice(0, HOME_TURNS_MAX);
}
