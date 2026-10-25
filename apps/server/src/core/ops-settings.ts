import { DEFAULT_OPS_SETTINGS, type ModuleKind, type ModuleSwitch, type OpsSettings } from '@one-line-desk/shared';
import type { AuditLog } from './audit';

// 운영 설정(ADR-12). 화면이 아니라 운영자만 바꾸는 값이고, 바꿀 때마다 감사 로그에 남겨요.
export class OpsSettingsStore {
  private settings: OpsSettings = structuredClone(DEFAULT_OPS_SETTINGS);

  constructor(private readonly audit: AuditLog) {}

  get(): OpsSettings {
    return this.settings;
  }

  setModule(operatorId: string, module: ModuleKind, value: ModuleSwitch): OpsSettings {
    this.settings = { ...this.settings, modules: { ...this.settings.modules, [module]: value } };
    this.audit.record({ pseudonymId: operatorId, channel: 'ops', module, action: 'switch.set', result: value });
    return this.settings;
  }

  setFlag(operatorId: string, flag: 'roomsWrite' | 'mcp', value: boolean): OpsSettings {
    this.settings = { ...this.settings, [flag]: value };
    this.audit.record({ pseudonymId: operatorId, channel: 'ops', action: `${flag}.set`, result: String(value) });
    return this.settings;
  }
}
