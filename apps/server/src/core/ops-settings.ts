import { DEFAULT_OPS_SETTINGS, isPantryStandalone, type ModuleKind, type ModuleSwitch, type OpsSettings } from '@one-line-desk/shared';
import type { AuditEntry, AuditLog } from './audit';
import type { Db } from './db';
import { DeskError } from './errors';

// 운영 설정(ADR-12). 화면이 아니라 운영자만 바꾸는 값이고, 바꿀 때마다 감사 로그에 남겨요.
// 바꾼 칸만 ops_settings 표에 저장해서 서버를 다시 켜도 그대로예요(QA-33). 없는 칸은 기본값(개발·시연 또는 출시 기본값)을 써요.
// 서버 한 대 기준이에요. 뜰 때 한 번 읽고, 바꿀 때 표와 메모리를 같이 바꿔요(여러 대는 L-58).

export type OpsValues = OpsSettings['values'];
/** 운영 설정의 켜고 끄는 값 */
export type OpsFlag = 'roomsWrite' | 'mcp' | 'autoActions';

interface Overrides {
  modules?: Partial<Record<ModuleKind, ModuleSwitch>>;
  roomsWrite?: boolean;
  mcp?: boolean;
  autoActions?: boolean;
  links?: Partial<Record<ModuleKind, string>>;
  values?: Partial<OpsValues>;
}

/** 운영 값 범위. 재직 재확인은 퇴사 10분 차단(ADR-13) 때문에 10분보다 짧아야 해요. */
export const OPS_VALUE_RANGE: Record<keyof OpsValues, readonly [number, number]> = {
  defaultMeetingMinutes: [15, 240],
  proposalTtlSeconds: [60, 3600],
  planTtlSeconds: [60, 3600],
  employmentRecheckSeconds: [30, 599],
  // 3시간까지만 받아요. 안내서 74쪽은 "통상적이며 합리적인 수준"을 요구하고, 오래 늘린 채 두는 것을 미조치 예로 들어요.
  idleTimeoutMinutes: [5, 180],
  rateLimitPerMinute: [1, 600],
};

export const NAVI_OFF_ONLY_STANDALONE = '담당 찾기는 공지·회의실이 모두 꺼진 같이 채워요 단독 모드에서만 끌 수 있어요';

function merge(base: OpsSettings, o: Overrides): OpsSettings {
  return {
    ...base,
    modules: { ...base.modules, ...o.modules },
    roomsWrite: o.roomsWrite ?? base.roomsWrite,
    mcp: o.mcp ?? base.mcp,
    autoActions: o.autoActions ?? base.autoActions,
    links: { ...base.links, ...o.links },
    values: { ...base.values, ...o.values },
  };
}

export class OpsSettingsStore {
  private overrides: Overrides = {};
  private settings: OpsSettings;

  constructor(
    private readonly audit: AuditLog,
    private readonly db: Db,
    private readonly defaults: OpsSettings = DEFAULT_OPS_SETTINGS,
  ) {
    this.settings = merge(structuredClone(defaults), {});
  }

  /** 서버가 뜰 때 저장된 운영 설정을 읽어요. */
  async load(): Promise<void> {
    const { rows } = await this.db.query<{ overrides: Overrides }>('select overrides from ops_settings where id = 1');
    this.overrides = rows[0]?.overrides ?? {};
    this.settings = merge(structuredClone(this.defaults), this.overrides);
  }

  get(): OpsSettings {
    return this.settings;
  }

  async setModule(operatorId: string, module: ModuleKind, value: ModuleSwitch): Promise<OpsSettings> {
    return this.save(
      { ...this.overrides, modules: { ...this.overrides.modules, [module]: value } },
      {
        pseudonymId: operatorId,
        channel: 'ops',
        module,
        action: 'switch.set',
        result: value,
      },
    );
  }

  async setFlag(operatorId: string, flag: OpsFlag, value: boolean): Promise<OpsSettings> {
    return this.save({ ...this.overrides, [flag]: value }, { pseudonymId: operatorId, channel: 'ops', action: `${flag}.set`, result: String(value) });
  }

  /** 운영 값(임시값, CD-14)을 바꿔요. 범위를 벗어나면 하나도 바꾸지 않아요. */
  async setValues(operatorId: string, values: Partial<OpsValues>): Promise<OpsSettings> {
    const keys = Object.keys(values) as (keyof OpsValues)[];
    if (keys.length === 0) throw new DeskError('bad-request', 400, '바꿀 값을 하나 이상 보내 주세요');
    for (const key of keys) {
      const [min, max] = OPS_VALUE_RANGE[key];
      const v = values[key]!;
      if (!Number.isInteger(v) || v < min || v > max) throw new DeskError('bad-request', 400, `${key}는 ${min}~${max} 사이 정수여야 해요`);
    }
    return this.save(
      { ...this.overrides, values: { ...this.overrides.values, ...values } },
      { pseudonymId: operatorId, channel: 'ops', action: 'values.set', result: keys.map((k) => `${k}=${values[k]}`).join(',') },
    );
  }

  /** "링크만"일 때 보내는 그룹웨어 주소(CD-4). https 주소만 받아요. */
  async setLink(operatorId: string, module: ModuleKind, url: string): Promise<OpsSettings> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DeskError('bad-request', 400, 'https 주소를 넣어 주세요');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new DeskError('bad-request', 400, 'https 주소를 넣어 주세요');
    return this.save(
      { ...this.overrides, links: { ...this.overrides.links, [module]: parsed.href } },
      {
        pseudonymId: operatorId,
        channel: 'ops',
        module,
        action: 'link.set',
        result: 'ok',
      },
    );
  }

  /** 시험·시연에서 값을 바꿀 때 써요. 표에 저장하지 않고, 감사 로그는 부르는 쪽이 남겨요. */
  patchValues(values: Partial<OpsValues>): void {
    this.overrides = { ...this.overrides, values: { ...this.overrides.values, ...values } };
    this.settings = merge(structuredClone(this.defaults), this.overrides);
  }

  /** 조합을 검사하고, 표 저장과 감사 1줄을 한 트랜잭션으로 해요. 실패하면 메모리 값도 그대로예요. */
  private async save(next: Overrides, entry: AuditEntry): Promise<OpsSettings> {
    const settings = merge(structuredClone(this.defaults), next);
    // ADR-12: 담당 찾기 끔은 같이 채워요 단독 모드에서만이에요(QA-14). 켤 때는 담당 찾기를 먼저 켜요.
    if (settings.modules.navi === 'off' && !isPantryStandalone(settings)) throw new DeskError('bad-combination', 409, NAVI_OFF_ONLY_STANDALONE);
    await this.db.tx(async (q) => {
      await q.query(
        `insert into ops_settings (id, overrides, version, updated_at) values (1, $1, 1, now())
         on conflict (id) do update set overrides = excluded.overrides, version = ops_settings.version + 1, updated_at = now()`,
        [JSON.stringify(next)],
      );
      await this.audit.record(entry, q);
    });
    this.overrides = next;
    this.settings = settings;
    return settings;
  }
}
