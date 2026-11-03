import {
  type ChartApplyResponse,
  INQUIRY_WEEK_MIN,
  type InquiryStatsResponse,
  type ChartListResponse,
  type ChartPreviewResponse,
  type ItFaqApplyResponse,
  type ItFaqListResponse,
  type ItFaqPreviewResponse,
  type PlanSheet,
  RECORD_KEEP_DAYS,
  REROUTE_REASON_LABEL,
  REROUTE_REASONS,
} from '@one-line-desk/shared';
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiFailure, apiRequest } from '../../api';
import { ConfirmSheet } from '../../components/ActionHost';
import type { ScreenProps } from '../types';
import './navi.css';

// S5 분장표 수정 제안함(PC 우선, 분장표 주인만). 이번 2주는 기록 묶음 목록 + 분장표 파일 다시 올리기만 있어요(D13 ②).
// 기록은 분장표를 자동으로 바꾸지 않아요. 주인이 고친 파일을 확인 시트로 올려야 반영돼요(R9).
// 11/3: 기록 묶음은 받는 곳을 바꿔 보낸 이유 둘(다른 팀·대표 창구)만 보여요. IT FAQ 주인 부서(IT지원팀)면 IT FAQ 파일 올리기 칸이 더 보여요.

/** 서버 한도(400,000자)보다 조금 작게 막아요. */
const MAX_FILE_BYTES = 380_000;

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
      <p className='lead'>
        {me.department} 행에 쌓인 기록 묶음이에요. 문의할 때 사람이 받는 곳을 바꿔 보낸 횟수예요(글·보낸 사람은 남지 않아요). 기록은 분장표를 바꾸지 않아요.
        고친 분장표 파일을 다시 올려야 반영돼요.
      </p>

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
                <caption className='hint'>개정일 뒤에 쌓인 기록이에요. 누가 바꿔 보냈는지와 문의 글은 없어요.</caption>
                <thead>
                  <tr>
                    <th scope='col'>업무</th>
                    {REROUTE_REASONS.map((r) => (
                      <th key={r} scope='col' className='num'>
                        {REROUTE_REASON_LABEL[r]}
                      </th>
                    ))}
                    <th scope='col'>개정일</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className={row.total > 0 ? 'has-records' : undefined}>
                      <th scope='row'>
                        <span className='row-task'>{row.task}</span>
                        <span className='row-id'>{row.id}</span>
                      </th>
                      {REROUTE_REASONS.map((r) => (
                        <td key={r} className='num'>
                          {row.feedback[r]}
                        </td>
                      ))}
                      <td className='date'>{row.revisedOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <InquiryStats />

      <UploadPanel config={chartUpload(me.department)} onApplied={() => setReload((n) => n + 1)} />

      <ItFaqPanel />
    </div>
  );
}

/** 미리보기 한 줄(분장표 행·IT FAQ 공통) */
interface PreviewChange {
  id: string;
  name: string;
  type: 'changed' | 'added';
  fields: { name: string; before?: string; after: string }[];
}

interface Preview {
  baseVersion: string;
  changes: PreviewChange[];
  unchanged: number;
  untouched: number;
}

interface UploadConfig {
  title: string;
  hint: ReactNode;
  exportPath: string;
  exportLabel: string;
  previewPath: string;
  applyPath: string;
  formatMessage: string;
  pasteLabel: string;
  /** 미리보기 응답을 공통 모양으로 바꿔요. */
  toPreview: (res: unknown) => Preview;
  sheet: (p: Preview) => PlanSheet;
  noChange: string;
  untouchedLabel: string;
  /** 미리보기에서 새로 더해지는 것의 이름(새 행·새 FAQ) */
  addedLabel: string;
  /** 바뀌지 않은 것의 이름(행·FAQ) */
  unchangedLabel: string;
}

function chartUpload(department: string): UploadConfig {
  return {
    title: '분장표 파일 다시 올리기',
    hint: (
      <>
        지금 분장표를 받아 우리 부서 행의 창구·지금 할 일·처리 기간·다른 말·온보딩 주차를 고친 뒤 올려 주세요. 온보딩 주차는 새로 온 분이 첫 2주에 챙길 일이면
        1이나 2를 적고, 아니면 비워 두세요.
      </>
    ),
    exportPath: '/api/navi/chart/export',
    exportLabel: '분장표 파일 받기',
    previewPath: '/api/navi/chart/preview',
    applyPath: '/api/navi/chart/apply',
    formatMessage: '분장표 양식으로 올려 주세요',
    pasteLabel: '또는 분장표 내용을 붙여넣기',
    toPreview: (res) => {
      const p = res as ChartPreviewResponse;
      return { ...p, changes: p.changes.map((c) => ({ id: c.rowId, name: c.task, type: c.type, fields: c.fields })) };
    },
    sheet: (p) => ({
      title: '분장표 파일 반영',
      lines: [`바뀌는 행 ${p.changes.length}개를 반영해요`, `${department} 행만 바뀌어요. 다른 부서 행은 바뀌지 않아요`, '바뀐 행은 개정일이 오늘로 올라가요'],
      confirmLabel: '반영하기',
      note: '바꿔 보낸 기록은 그대로 남아요.',
    }),
    noChange: '바뀌는 행이 없어요.',
    untouchedLabel: '파일에 없는 우리 부서 행',
    addedLabel: '새 행',
    unchangedLabel: '행',
  };
}

const itFaqUpload: UploadConfig = {
  title: 'IT FAQ 파일 올리기',
  hint: (
    <>
      지금 IT FAQ를 받아 고치거나 새 FAQ를 더한 뒤 올려 주세요. 칸은 ID·제목·다른 말·오류 코드·단계·개정일·문의 행이에요. 단계는 칸 안에서 줄을 바꿔 한 줄에
      하나씩 적고, 다른 말·오류 코드는 |로 나눠요. 문의 행에는 해결이 안 될 때 문의를 받을 우리 부서 분장표 행 ID(예: IT-06)를 적어요. 단계는 적은 그대로
      보여요.
    </>
  ),
  exportPath: '/api/navi/it-faq/export',
  exportLabel: 'IT FAQ 파일 받기',
  previewPath: '/api/navi/it-faq/preview',
  applyPath: '/api/navi/it-faq/apply',
  formatMessage: 'IT FAQ 양식으로 올려 주세요',
  pasteLabel: '또는 IT FAQ 내용을 붙여넣기',
  toPreview: (res) => {
    const p = res as ItFaqPreviewResponse;
    return { ...p, changes: p.changes.map((c) => ({ id: c.faqId, name: c.title, type: c.type, fields: c.fields })) };
  },
  sheet: (p) => ({
    title: 'IT FAQ 파일 반영',
    lines: [`바뀌는 FAQ ${p.changes.length}개를 반영해요`, '우리 부서 FAQ만 바뀌어요. 파일에 없는 FAQ는 지우지 않아요', '바뀐 FAQ는 개정일이 오늘로 올라가요'],
    confirmLabel: '반영하기',
    note: 'IT 오류 화면에서 누구나 단계를 적은 그대로 봐요.',
  }),
  noChange: '바뀌는 FAQ가 없어요.',
  untouchedLabel: '파일에 없는 우리 부서 FAQ',
  addedLabel: '새 FAQ',
  unchangedLabel: 'FAQ',
};

/** 파일 다시 올리기: 파일 고르기·붙여넣기 → 바뀌는 행·칸 미리보기 → 확인 시트 → 반영(고정 버튼) */
function UploadPanel({ config, onApplied }: { config: UploadConfig; onApplied: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
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
      setError(config.formatMessage);
      return;
    }
    reset(await file.text());
  }

  async function download() {
    setError(null);
    try {
      const res = await apiRequest<{ filename: string; csv: string }>('GET', config.exportPath);
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
      setPreview(config.toPreview(await apiRequest<unknown>('POST', config.previewPath, { csv })));
    } catch (e) {
      setPreview(null);
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className='card chart-upload'>
      <h2>{config.title}</h2>
      <p className='hint chart-phone-only'>폰에서는 목록만 봐요. 파일 올리기는 PC에서 해요.</p>
      <div className='chart-pc-only'>
        <p className='hint'>{config.hint}</p>
        <div className='chart-row-buttons'>
          <button type='button' className='secondary small' onClick={() => void download()}>
            {config.exportLabel}
          </button>
          <label className='secondary small chart-file'>
            파일 고르기
            <input type='file' accept='.csv,text/csv' onChange={(e) => void pickFile(e)} />
          </label>
        </div>
        <label className='chart-paste'>
          <span className='hint'>{config.pasteLabel}</span>
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
              <p className='empty'>{config.noChange}</p>
            ) : (
              <ul className='plain'>
                {preview.changes.map((c) => (
                  <li key={c.id}>
                    <strong>
                      {c.name} <span className='row-id'>{c.id}</span> · {c.type === 'added' ? config.addedLabel : '바뀜'}
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
              바뀌지 않은 {config.unchangedLabel} {preview.unchanged}개
              {preview.untouched > 0 ? ` · ${config.untouchedLabel} ${preview.untouched}개는 그대로 둬요` : ''}
            </p>
            {preview.changes.length > 0 && (
              <button type='button' className='primary' onClick={() => setConfirming(true)}>
                반영하기
              </button>
            )}
          </div>
        )}
      </div>

      {confirming && preview && (
        <ConfirmSheet
          sheet={config.sheet(preview)}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            try {
              const res = await apiRequest<ChartApplyResponse | ItFaqApplyResponse>('POST', config.applyPath, { csv, baseVersion: preview.baseVersion });
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

/**
 * IT FAQ 파일 올리기(11/3). IT FAQ 주인 부서(FAQ 문의 행의 주인 부서, 지금은 IT지원팀) 분장표 주인에게만 보여요.
 * 서버가 부서를 다시 확인해서, 화면을 고쳐 열어도 다른 부서는 올리지 못해요.
 */
function ItFaqPanel() {
  const [data, setData] = useState<ItFaqListResponse | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    apiRequest<ItFaqListResponse>('GET', '/api/navi/it-faq')
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [reload]);
  if (!data?.enabled) return null;
  const demo = data.faqs.filter((f) => f.source === 'demo').length;

  return (
    <>
      <section className='card'>
        <h2>IT FAQ</h2>
        <p className='hint'>
          {data.department} FAQ {data.faqs.length}개예요{demo > 0 ? `. 그중 ${demo}개는 가상 FAQ예요` : ''}. IT 오류 화면이 이 FAQ의 단계를 적은 그대로 보여
          줘요.
        </p>
        <div className='chart-table-wrap'>
          <table className='chart-table'>
            <thead>
              <tr>
                <th scope='col'>제목</th>
                <th scope='col' className='num'>
                  단계
                </th>
                <th scope='col'>개정일</th>
              </tr>
            </thead>
            <tbody>
              {data.faqs.map((f) => (
                <tr key={f.id}>
                  <th scope='row'>
                    <span className='row-task'>{f.title}</span>
                    <span className='row-id'>{f.id}</span>
                    {f.source === 'demo' && <span className='row-id'>가상</span>}
                  </th>
                  <td className='num'>{f.steps.length}</td>
                  <td className='date'>{f.revisedOn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <UploadPanel config={itFaqUpload} onApplied={() => setReload((n) => n + 1)} />
    </>
  );
}

/**
 * 받은 문의 주간 셈(10/31 넓힐 후보 ④). 우리 부서로 온 문의를 보낸 주별로 센 건수예요. 사람·글은 없어요.
 * 그 주 문의가 다 지워진 뒤(보관 7일)에 세서, 보이는 건 지난 한 주 남짓이에요. 10건이 안 되면 숫자를 접어요.
 * 좋고 나쁨을 색으로 나누거나 부서끼리 견주지 않아요(10/31 디자이너).
 */
function InquiryStats() {
  const [data, setData] = useState<InquiryStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiRequest<InquiryStatsResponse>('GET', '/api/navi/inquiry-stats')
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(failureText(e)));
    return () => {
      alive = false;
    };
  }, []);
  const day = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

  return (
    <section className='card inquiry-stats'>
      <h2>받은 문의 주간 셈</h2>
      {error && (
        <p className='lock-line' role='alert'>
          {error}
        </p>
      )}
      {!data && !error && <div className='skeleton' aria-hidden='true' />}
      {/* 11/3 QA L8: 명령형으로 읽히던 "…지워질 때 세요"를 바꾸고, 언제 숫자가 보이는지와 접는 기준을 같이 적어요. */}
      {data && data.weeks.length === 0 && (
        <p className='empty'>
          아직 다 센 주가 없어요. 문의는 보낸 지 {RECORD_KEEP_DAYS}일이 지나 지워질 때 한 번 세어져요. 한 주에 보낸 문의가 모두 지워진 다음 주에 숫자가 보이고,
          {INQUIRY_WEEK_MIN}건이 안 되는 주는 숫자를 접어 두어요.
        </p>
      )}
      {data && data.weeks.length > 0 && (
        <div className='chart-table-wrap'>
          <table className='chart-table'>
            <thead>
              <tr>
                <th scope='col'>보낸 주</th>
                <th scope='col' className='num'>
                  받은 문의
                </th>
                <th scope='col' className='num'>
                  처리함
                </th>
                <th scope='col' className='num'>
                  처리 전에 지워짐
                </th>
              </tr>
            </thead>
            <tbody>
              {data.weeks.map((w) => (
                <tr key={w.week}>
                  <th scope='row'>
                    {day(w.from)}~{day(w.to)}
                  </th>
                  {w.folded ? (
                    <td colSpan={3} className='hint'>
                      {INQUIRY_WEEK_MIN}건이 안 돼서 숫자를 접었어요
                    </td>
                  ) : (
                    <>
                      <td className='num'>{w.sent}</td>
                      <td className='num'>{w.handled}</td>
                      <td className='num'>{w.expiredOpen}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className='hint'>사람·글은 세지 않고 부서 건수만 세어요. 셈도 {RECORD_KEEP_DAYS}일 뒤 지워져요.</p>
    </section>
  );
}
