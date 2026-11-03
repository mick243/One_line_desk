import { describe, expect, it, vi } from 'vitest';
import { newVersionAvailable, onNewVersion } from '../api';
import { loadPart } from './LazyPart';

// 따로 불러오는 화면(역할 화면·동의 시트·휴가 신청). 배포 뒤 옛 조각을 못 불러도 화면을 깨지 않고 새 버전 띠를 띄워요.

describe('필요할 때 불러오는 화면 조각', () => {
  it('불러오면 그 부품을 그대로 써요', async () => {
    const Part = () => null;
    const listener = vi.fn();
    const off = onNewVersion(listener);
    const loaded = await loadPart(() => Promise.resolve(Part));
    off();
    expect(loaded.default).toBe(Part);
    expect(listener).not.toHaveBeenCalled();
  });

  it('옛 조각을 못 부르면 던지지 않고 새 버전을 알려요(닫은 띠도 다시 떠요)', async () => {
    const Part = () => null;
    const listener = vi.fn();
    const off = onNewVersion(listener);
    const first = await loadPart<object>(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    const second = await loadPart<object>(() => Promise.reject(new Error('preload')));
    off();
    expect(first.default).not.toBe(Part);
    expect(second.default).toBe(first.default);
    expect(newVersionAvailable()).toBe(true);
    // 머리로 알아챈 새 판과 달리 실패할 때마다 알려서, 닫아 둔 띠도 다시 띄워요.
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
