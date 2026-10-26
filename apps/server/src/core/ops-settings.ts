import { DEFAULT_OPS_SETTINGS, type ModuleKind, type ModuleSwitch, type OpsSettings } from '@one-line-desk/shared';
import type { AuditLog } from './audit';

// 운영 설정(ADR-12). 화면이 아니라 운영자만 바꾸는 값이고, 바꿀 때마다 감사 로그에 남겨요.
// 지금은 서버 메모리에 둬요. 서버를 다시 켜면 기본값으로 돌아가요.
export class OpsSettingsStore {
  private settings: OpsSettings = structuredClone(DEFAULT_OPS_SETTINGS);

  constructor(private readonly audit: AuditLog) {}

  get(): OpsSettings {
    return this.settings;
  }

  async setModule(operatorId: string, module: ModuleKind, value: ModuleSwitch): Promise<OpsSettings> {
    this.settings = { ...this.settings, modules: { ...this.settings.modules, [module]: value } };
    await this.audit.record({ pseudonymId: operatorId, channel: 'ops', module, action: 'switch.set', result: value });
    return this.settings;
  }

  async setFlag(operatorId: string, flag: 'roomsWrite' | 'mcp', value: boolean): Promise<OpsSettings> {
    this.settings = { ...this.settings, [flag]: value };
    await this.audit.record({ pseudonymId: operatorId, channel: 'ops', action: `${flag}.set`, result: String(value) });
    return this.settings;
  }

  /** 시험·시연에서 값을 바꿀 때 써요. 감사 로그는 부르는 쪽이 남겨요. */
  patchValues(values: Partial<OpsSettings['values']>): void {
    this.settings = { ...this.settings, values: { ...this.settings.values, ...values } };
  }
}
