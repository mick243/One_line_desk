import { MockEmployees } from './mock/employees';
import type { AdapterCapabilities, DirectoryAdapter, IdpAdapter } from './types';

export interface Adapters {
  idp: IdpAdapter;
  directory: DirectoryAdapter;
  /** 띠에 보여 줄 목록. 회의실 장부·공지·분장표·카탈로그 어댑터가 생기면 여기에 더해요. */
  all(): AdapterCapabilities[];
}

export function createMockAdapters(): Adapters & { employees: MockEmployees } {
  const employees = new MockEmployees();
  return {
    idp: employees,
    directory: employees,
    employees,
    all: () => [employees.capabilities],
  };
}
