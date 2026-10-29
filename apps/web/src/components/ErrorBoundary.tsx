import { Component, type ReactNode } from 'react';

// 화면을 그리다 실패하면 흰 화면 대신 안내를 보여 줘요(10/29 배포 준비 회의 D3). 옛 브라우저·지워진 옛 파일 같은 경우예요.
// 오류 내용은 어디에도 보내거나 남기지 않아요(R13).
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className='loading' role='alert'>
        <p>화면을 열지 못했어요. 새로 고쳐 주세요. 계속 안 되면 Edge·Chrome 최신 판으로 열어 주세요.</p>
        <button type='button' className='secondary small' onClick={() => window.location.reload()}>
          다시 불러오기
        </button>
      </div>
    );
  }
}
