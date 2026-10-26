/** 경로에서 { error, message }로 바뀌는 오류. message는 화면에 그대로 보여 줄 해요체 문구예요. */
export class DeskError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const forbidden = () => new DeskError('forbidden', 403, '이 일을 할 권한이 없어요');
export const notFound = () => new DeskError('not-found', 404, '찾을 수 없어요');
