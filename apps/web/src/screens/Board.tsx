import type { Me } from '../api';
import { CheckedInput } from '../components/CheckedInput';

// S3 같이 채워요 판. 게시·+1·합치기는 7~8일 차에 만들어요. 누가 표를 줬는지는 화면 어디에도 안 보여요.
export function Board({ me }: { me: Me }) {
  return (
    <div className="board">
      <header className="screen-head">
        <h1>{me.floor} 같이 채워요</h1>
        {me.roles.includes('facilities') && (
          <button type="button" className="secondary small" disabled title="S4 총무 운영은 8~9일 차에 만들어요">
            운영
          </button>
        )}
      </header>
      <CheckedInput scope="우리 층 모두에게 보여요" placeholder="필요한 간식·비품을 적어 주세요" submitLabel="올리기" disabledReason="게시는 7일 차에 만들어요" />
      <section className="card">
        <h2>열린 품목</h2>
        <p className="empty">아직 요청이 없어요.</p>
      </section>
    </div>
  );
}
