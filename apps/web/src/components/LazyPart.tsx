import { type ComponentType, lazy, Suspense } from 'react';
import { markNewVersion } from '../api';

// 역할이 있는 사람만 보는 화면은 처음 열 때 따로 불러요(첫 화면 JS를 줄여요).
// 배포 뒤 오래 연 탭은 지워진 옛 조각을 부르다 실패할 수 있어요. 그때 화면을 깨지 않고 새 버전 띠를 띄워 새로 고침을 권해요.
// 오류 내용은 어디에도 보내거나 남기지 않아요(R13).

/** 옛 화면 조각을 부르지 못했을 때 그 자리에 보여요. 문구는 "옛 화면이 없는 API를 부름(D2)"과 같아요. */
export const OLD_PART_MESSAGE = '화면이 옛 버전이에요. 새로 고친 뒤 다시 해 주세요';

type AnyProps = Record<string, unknown>;

function OldPart(props: AnyProps) {
  const close = typeof props.onClose === 'function' ? (props.onClose as () => void) : typeof props.onBack === 'function' ? (props.onBack as () => void) : null;
  return (
    <div className='loading' role='alert'>
      <p>{OLD_PART_MESSAGE}</p>
      <button type='button' className='secondary small' onClick={() => window.location.reload()}>
        새로 고침
      </button>
      {close && (
        <button type='button' className='neutral small' onClick={close}>
          닫기
        </button>
      )}
    </div>
  );
}

/** 조각을 불러요. 실패하면 던지지 않고 새 버전을 알린 뒤 OldPart를 돌려줘요(React.lazy는 한 번 정한 결과를 다시 부르지 않아요). */
export async function loadPart<P>(load: () => Promise<ComponentType<P>>): Promise<{ default: ComponentType<P> }> {
  try {
    return { default: await load() };
  } catch {
    markNewVersion();
    return { default: OldPart as ComponentType<P> };
  }
}

/** 필요할 때 불러오는 화면 부품. 불러오는 동안은 첫 화면과 같은 "불러오는 중…"을 보여요. */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Lazy = lazy(() => loadPart(load)) as unknown as ComponentType<P>;
  function Part(props: P) {
    return (
      <Suspense fallback={<div className='loading'>불러오는 중…</div>}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return Part;
}
