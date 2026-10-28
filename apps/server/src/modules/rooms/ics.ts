// 캘린더 파일(.ics, RFC 5545) 만들기(ADR-17). 우리 서버는 어디에도 보내지 않고, 사람이 받아서 자기 캘린더에 넣거나 전달해요.
// 참석자 메일·회의 제목은 넣지 않아요. 회의실·시간과 "한 줄 데스크에서 예약한 회의"라는 한 줄만 들어가요.

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC 시각 20261027T060000Z */
function utc(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 글 값 안의 \ ; , 줄바꿈을 막아요(RFC 5545 3.3.11). */
function text(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 한 줄이 75바이트를 넘으면 접어요(RFC 5545 3.1). 한글이 잘리지 않게 글자 단위로 끊어요. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

export interface IcsMeeting {
  uid: string;
  roomName: string;
  floor: string;
  start: number;
  end: number;
  stamp: number;
  /** 앱에서 보기 주소 */
  url: string;
}

export function buildIcs(m: IcsMeeting): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//One Line Desk//Rooms//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${text(m.uid)}`,
    `DTSTAMP:${utc(m.stamp)}`,
    `DTSTART:${utc(m.start)}`,
    `DTEND:${utc(m.end)}`,
    `SUMMARY:${text(`회의 · ${m.roomName}`)}`,
    `LOCATION:${text(`${m.roomName} (${m.floor})`)}`,
    `DESCRIPTION:${text('한 줄 데스크에서 예약한 회의예요.')}`,
    `URL:${m.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
