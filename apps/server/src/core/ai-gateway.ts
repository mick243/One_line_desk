import { gatewayAllows, type Grade, type ModuleKind } from '@one-line-desk/shared';

// LLM은 이 게이트웨이 하나로만 불러요(ADR-10). 등급 검사·모델 고정·무상태 호출을 여기서 지켜요.
export interface GatewayRequest {
  module: ModuleKind | 'router';
  purpose: string;
  grade: Grade;
}

export class GatewayRefused extends Error {
  constructor(grade: Grade) {
    super(`등급 ${grade} 자료는 AI로 보내지 않아요`);
  }
}

export class AiGateway {
  constructor(private readonly contractConfirmed: boolean) {}

  async call(req: GatewayRequest): Promise<never> {
    if (!gatewayAllows(req.grade, this.contractConfirmed)) throw new GatewayRefused(req.grade);
    // 2일 차: 무보관 모델 고정, 요청 하나에 호출 하나, 쓰기 도구 없음, 본문 없는 비용 집계.
    throw new Error('모델 연결은 아직 만들지 않았어요(2일 차)');
  }
}
