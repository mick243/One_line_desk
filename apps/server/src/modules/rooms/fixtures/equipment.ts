import type { Equipment, FacilityStatus } from '@one-line-desk/shared';
import type { LoanItemRow } from '../repo';

// 시연용 이동식 장비와 설비 상태(등급 0, 가상). 실제 재고가 정해지면 총무가 바꿔요(ADR-19).

export const DEMO_EQUIPMENT: LoanItemRow[] = [
  { id: 'eq-projector-1', kind: '빔프로젝터', name: '빔프로젝터 1', home: '2층 총무 보관함' },
  { id: 'eq-projector-2', kind: '빔프로젝터', name: '빔프로젝터 2', home: '4층 보관함' },
  { id: 'eq-laptop-1', kind: '노트북', name: '노트북 A', home: '2층 총무 보관함' },
  { id: 'eq-laptop-2', kind: '노트북', name: '노트북 B', home: '2층 총무 보관함' },
  { id: 'eq-laptop-3', kind: '노트북', name: '노트북 C', home: '4층 보관함' },
  { id: 'eq-mic-1', kind: '무선 마이크', name: '무선 마이크 1', home: '5층 대회의실 옆 보관함' },
  { id: 'eq-mic-2', kind: '무선 마이크', name: '무선 마이크 2', home: '5층 대회의실 옆 보관함' },
  { id: 'eq-webcam-1', kind: '웹캠', name: '웹캠 1', home: '2층 총무 보관함' },
  { id: 'eq-webcam-2', kind: '웹캠', name: '웹캠 2', home: '4층 보관함' },
  { id: 'eq-speaker-1', kind: '스피커폰', name: '스피커폰 1', home: '3층 보관함' },
  { id: 'eq-speaker-2', kind: '스피커폰', name: '스피커폰 2', home: '4층 보관함' },
  { id: 'eq-hdmi-1', kind: 'HDMI 젠더', name: 'HDMI 젠더 1', home: '2층 총무 보관함' },
  { id: 'eq-hdmi-2', kind: 'HDMI 젠더', name: 'HDMI 젠더 2', home: '2층 총무 보관함' },
  { id: 'eq-hdmi-3', kind: 'HDMI 젠더', name: 'HDMI 젠더 3', home: '3층 보관함' },
];

/** 처음 한 번만 넣어요. 총무가 바꾼 뒤에는 그대로 둬요. */
export const DEMO_FACILITY_STATUS: { roomId: string; facility: Equipment; status: FacilityStatus }[] = [
  { roomId: 'r-5a', facility: '화상회의', status: 'repair' },
];
