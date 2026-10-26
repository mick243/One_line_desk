import {
  type ChartApplyResponse,
  type ChartListResponse,
  type ChartPreviewResponse,
  type PlanSheet,
  WRONG_REASON_LABEL,
  WRONG_REASONS,
} from '@one-line-desk/shared';
import { type ChangeEvent, useCallback, useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { ConfirmSheet } from '../../components/ActionHost';
import type { ScreenProps } from '../types';
import './navi.css';

// S5 분장표 수정 제안함(PC 우선, 분장표 주인만). 이번 2주는 기록 묶음 목록 + 분장표 파일 다시 올리기만 있어요(D13 ②).
// 기록은 분장표를 자동으로 바꾸지 않아요. 주인이 고친 파일을 확인 시트로 올려야 반영돼요(R9).

/** 서버 한도(400,000자)보다 조금 작게 막아요. */
const MAX_FILE_BYTES = 380_000;
const FORMAT_MESSAGE = '분장표 양식으로 올려 주세요';

function failureText(e: unknown): string {
  return e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요';
}

export function ChartScreen({ me }: ScreenProps) {
  const [data, setData] = useState<ChartListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    apiRequest<ChartListResponse>('GET', '/api/navi/chart')
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setLoadError(failureText(e)));
    return () => {
      alive = false;
    };
  }, [reload]);

  const quiet = data !== null && data.rows.every((r) => r.total === 0);

  return (
    <div className='chart'>
      <header className='screen-head'>
        <h1>분장표 수정 제안함</h1>
      </header>
      <p className='lead'>{me.department} 행에 쌓인 "틀렸어요" 기록 묶음이에요. 기록은 분장표를 바꾸지 않아요. 고친 분장표 파일을 다시 올려야 반영돼요.</p>

      <section className='card'>
        <h2>기록 묶음</h2>
        {loadError && (
          <p className='lock-line' role='alert'>
            {loadError}
          </p>
        )}
        {!data && !loadError && <div className='skeleton' aria-hidden='true' />}
        {data && (
          <>
            {quiet && <p className='empty'>새로 쌓인 기록이 없어요.</p>}
            <div className='chart-table-wrap'>
              <table className='chart-table'>
                <caption className='hint'>개정일 뒤에 쌓인 기록이에요. 누가 골랐는지와 질문 원문은 없어요.</caption>
                <thead>
                  <tr>
                    <th scope='col'>업무</th>
                    {WRONG_REASONS.map((r) => (
                      <th key={r} scope='col' className='num'>
                        {WRONG_REASON_LABEL[r]}
                      </th>
                    ))}
                    <th scope='col'>개정일</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className={row.total > 0 ? 'has-records' : undefined}>
                      <th scope='row'>
                        {row.task}
                        <span className='row-id'>{row.id}</span>
                      </th>
                      {WRONG_REASONS.map((r) => (
                        <td key={r} className='num'>
                          {row.feedback[r]}
                        </td>
                      ))}
                      <td>{row.revisedOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <UploadPanel department={me.department} onApplied={() => setReload((n) => n + 1)} />
    </div>
  );
}

/** 분장표 파일 다시 올리기: 파일 고르기·붙여넣기 → 바뀌는 행·칸 미리보기 → 확인 시트 → 반영 */
function UploadPanel({ department, onApplied }: { department: string; onApplied: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ChartPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const reset = useCallback((next: string) => {
    setCsv(next);
    setPreview(null);
    setError(null);
    setDone(null);
  }, []);

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      reset('');
      setError(FORMAT_MESSAGE);
      return;
    }
    reset(await file.text());
  }

  async function download() {
    setError(null);
    try {
      const res = await apiRequest<{ filename: string; csv: string }>('GET', '/api/navi/chart/export');
      const url = URL.createObjectURL(new Blob([res.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(failureText(e));
    }
  }

  async function runPreview() {
    if (!csv.trim() || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setPreview(await apiRequest<ChartPreviewResponse>('POST', '/api/navi/chart/preview', { csv }));
    } catch (e) {
      setPreview(null);
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  }

  const sheet: PlanSheet | null = preview
    ? {
        title: '분장표 파일 반영',
        lines: [
          `바뀌는 행 ${preview.changes.length}개를 반영해요`,
          `${department} 행만 바뀌어요. 다른 부서 행은 바뀌지 않아요`,
          '바뀐 행은 개정일이 오늘로 올라가요',
        ],
        confirmLabel: '반영하기',
        note: '"틀렸어요" 기록은 그대로 남아요.',
      }
    : null;

  return (
    <section className='card chart-upload'>
      <h2>분장표 파일 다시 올리기</h2>
      <p className='hint chart-phone-only'>폰에서는 목록만 봐요. 파일 올리기는 PC에서 해요.</p>
      <div className='chart-pc-only'>
        <p className='hint'>지금 분장표를 받아 우리 부서 행의 창구·지금 할 일·처리 기간·다른 말을 고친 뒤 올려 주세요.</p>
        <div className='chart-row-buttons'>
          <button type='button' className='secondary small' onClick={() => void download()}>
            분장표 파일 받기
          </button>
          <label className='secondary small chart-file'>
            파일 고르기
            <input type='file' accept='.csv,text/csv' onChange={(e) => void pickFile(e)} />
          </label>
        </div>
        <label className='chart-paste'>
          <span className='hint'>또는 분장표 내용을 붙여넣기</span>
          <textarea value={csv} rows={6} spellCheck={false} autoComplete='off' onChange={(e) => reset(e.target.value)} />
        </label>
        <button type='button' className='secondary' disabled={!csv.trim() || busy} onClick={() => void runPreview()}>
          {busy ? '미리 보는 중' : '미리 보기'}
        </button>

        {error && (
          <p className='lock-line' role='alert'>
            {error}
          </p>
        )}
        {done && <p role='status'>{done}</p>}

        {preview && (
          <div className='chart-preview'>
            {preview.changes.length === 0 ? (
              <p className='empty'>바뀌는 행이 없어요.</p>
            ) : (
              <ul className='plain'>
                {preview.changes.map((c) => (
                  <li key={c.rowId}>
                    <strong>
                      {c.task} <span className='row-id'>{c.rowId}</span> · {c.type === 'added' ? '새 행' : '바뀜'}
                    </strong>
                    <ul className='plain'>
                      {c.fields.map((f) => (
                        <li key={f.name}>
                          {f.name}: {f.before !== undefined ? `${f.before || '(빈 칸)'} → ` : ''}
                          {f.after || '(빈 칸)'}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            <p className='hint'>
              바뀌지 않은 행 {preview.unchanged}개{preview.untouched > 0 ? ` · 파일에 없는 우리 부서 행 ${preview.untouched}개는 그대로 둬요` : ''}
            </p>
            {preview.changes.length > 0 && (
              <button type='button' className='primary' onClick={() => setConfirming(true)}>
                반영하기
              </button>
            )}
          </div>
        )}
      </div>

      {confirming && sheet && preview && (
        <ConfirmSheet
          sheet={sheet}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            try {
              const res = await apiRequest<ChartApplyResponse>('POST', '/api/navi/chart/apply', { csv, baseVersion: preview.baseVersion });
              reset('');
              setDone(res.message);
              onApplied();
            } catch (e) {
              setError(failureText(e));
            } finally {
              setConfirming(false);
            }
          }}
        />
      )}
    </section>
  );
}
