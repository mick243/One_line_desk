import { useEffect, useState } from 'react';
import { SLOW_MS } from '../net';

/** 기다린 지 SLOW_MS가 넘었는지. 기다림이 끝나면 다시 false예요(10/29 개선 회의 A3). */
export function useSlow(waiting: boolean, ms = SLOW_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const id = window.setTimeout(() => setSlow(true), ms);
    return () => window.clearTimeout(id);
  }, [waiting, ms]);
  return slow;
}
