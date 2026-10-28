import type { ReactNode } from 'react';

// 선 아이콘 한 벌(10/26 디자인 정리). 색은 글자색(currentColor)을 따라가서 컴포넌트에 색 값을 쓰지 않아요.

export type IconName = 'home' | 'navi' | 'rooms' | 'notices' | 'pantry' | 'mine' | 'bell' | 'chevron' | 'lock' | 'people' | 'close';

const PATHS: Record<IconName, ReactNode> = {
  home: <path d='M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4.2v-5.6H9.2v5.6H5A1.5 1.5 0 0 1 3.5 19z' />,
  navi: (
    <>
      <path d='M12 3v3M12 13v8' />
      <path d='M5.5 6h10.8l2.7 3.5-2.7 3.5H5.5z' />
    </>
  ),
  rooms: (
    <>
      <path d='M4 20.5h16' />
      <path d='M6.5 20.5V4.8A1.3 1.3 0 0 1 7.8 3.5h8.4a1.3 1.3 0 0 1 1.3 1.3v15.7' />
      <path d='M14 12.2v.1' />
    </>
  ),
  notices: (
    <>
      <path d='M4 10.2v3.6a1 1 0 0 0 1 1h2.6l5.4 4.2V5L7.6 9.2H5a1 1 0 0 0-1 1z' />
      <path d='M16.5 9.2a4 4 0 0 1 0 5.6M19 6.8a7.5 7.5 0 0 1 0 10.4' />
    </>
  ),
  pantry: (
    <>
      <path d='M4.5 9h12v4.5a5.5 5.5 0 0 1-5.5 5.5h-1a5.5 5.5 0 0 1-5.5-5.5z' />
      <path d='M16.5 10.5h1.3a2.4 2.4 0 0 1 0 4.8h-1.6' />
      <path d='M8.5 3.5v2.5M12.5 3.5v2.5' />
    </>
  ),
  mine: (
    <>
      <circle cx='12' cy='8' r='4' />
      <path d='M4.5 20.5a7.5 7.5 0 0 1 15 0' />
    </>
  ),
  bell: (
    <>
      <path d='M6 9.5a6 6 0 1 1 12 0v3.8l1.6 3.2H4.4L6 13.3z' />
      <path d='M10 19.5a2 2 0 0 0 4 0' />
    </>
  ),
  chevron: <path d='m9.5 6 6 6-6 6' />,
  close: <path d='m6.5 6.5 11 11m0-11-11 11' />,
  lock: (
    <>
      <rect x='5' y='10.5' width='14' height='10' rx='2.5' />
      <path d='M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' />
    </>
  ),
  people: (
    <>
      <circle cx='9' cy='8.5' r='3.2' />
      <path d='M3.5 19.5a5.5 5.5 0 0 1 11 0' />
      <circle cx='16.8' cy='9.5' r='2.4' />
      <path d='M16 14.3a4.8 4.8 0 0 1 4.5 5.2' />
    </>
  ),
};

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg
      className='icon'
      viewBox='0 0 24 24'
      width={size}
      height={size}
      fill='none'
      stroke='currentColor'
      strokeWidth={1.8}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      {PATHS[name]}
    </svg>
  );
}
