import { checkItemName, type FloorSetting, type MergeRecord, type MergeSuggestion, PANTRY_TEXT, type PlanSheet } from '@one-line-desk/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiFailure } from '../../api';
import { ConfirmSheet } from '../../components/ActionHost';
import { Sheet } from '../../components/Sheet';
import type { ScreenProps } from '../types';
import { pantryApi } from './pantry-api';

// S4 ① 합치기 제안함 ② 합친 기록 ④ 설정(총무만, PC 우선). ③ 주문안은 주문안 에이전트(./order)가 그려요.
// [합치기]·[되돌리기]는 확인 시트를 거치고, [따로 두기]는 바로 실행해요(R2).
// 다른 총무가 먼저 바꿨으면 409 → "다른 총무가 먼저 이 품목을 바꿨어요. 새로 불러왔어요."와 함께 다시 불러요(R3).

interface Confirming {
  sheet: PlanSheet;
  run: () => Promise<unknown>;
}

export function MergePanel({ me }: ScreenProps) {
  const [floor, setFloor] = useState(me.floor);
  const [settings, setSettings] = useState<FloorSetting[]>([]);
  const [suggestions, setSuggestions] = useState<MergeSuggestion[] | null>(null);
  const [records, setRecords] = useState<MergeRecord[] | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(
    async (collect: boolean) => {
      try {
        const s = collect ? await pantryApi.collect(floor) : await pantryApi.suggestions(floor);
        setSuggestions(s.suggestions);
        setRecords((await pantryApi.merges(floor)).merges);
      } catch (e) {
        setMessage(e instanceof ApiFailure ? e.message : '불러오지 못했어요');
      }
    },
    [floor],
  );

  useEffect(() => {
    pantryApi
      .settings()
      .then((r) => setSettings(r.floors))
      .catch(() => setSettings([]));
  }, []);

  // S4를 열 때(층을 바꿀 때) 남은 후보를 한 번 더 모아요(R15).
  useEffect(() => {
    void reload(true);
  }, [reload]);

  function fail(e: unknown) {
    setMessage(e instanceof ApiFailure ? e.message : '지금 처리하지 못했어요');
    void reload(false);
  }

  function askMerge(s: MergeSuggestion) {
    setConfirming({
      sheet: {
        title: '합치기',
        lines: [
          `대표 이름: ${s.representativeName}`,
          `카탈로그 품목: ${s.catalogName ?? '없음'}`,
          `합친 뒤 표 수: ${s.votesAfter}표(서로 다른 사람 수)`,
          `묶이는 이름: ${s.a.name}, ${s.b.name}`,
        ],
        confirmLabel: '합치기',
        note: '투표 기록은 그대로예요. 되돌리면 표 수가 합치기 전으로 돌아가요.',
      },
      run: () => pantryApi.merge([s.a.bundleId, s.b.bundleId], [s.a.bundleVersion, s.b.bundleVersion]),
    });
  }

  function askRevert(r: MergeRecord) {
    setConfirming({
      sheet: { title: '되돌리기', lines: [`${r.representativeName} ← ${r.mergedName}`, PANTRY_TEXT.revertNote], confirmLabel: '되돌리기' },
      run: () => pantryApi.revert(r.mergeId, r.bundleVersion),
    });
  }

  async function keepApart(s: MergeSuggestion) {
    const key = `${s.a.bundleId}-${s.b.bundleId}`;
    setBusy(key);
    try {
      await pantryApi.keepApart([s.a.bundleId, s.b.bundleId]);
      await reload(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  const floors = settings.map((s) => s.floor);
  return (
    <>
      <section className='card' aria-label='층 고르기'>
        <h2>층</h2>
        <div className='chips'>
          {(floors.length ? floors : [me.floor]).map((f) => (
            <button key={f} type='button' className={f === floor ? 'chip selected' : 'chip'} aria-pressed={f === floor} onClick={() => setFloor(f)}>
              {f}
            </button>
          ))}
        </div>
      </section>

      <section className='card' aria-label='합치기 제안함'>
        <h2>합치기 제안함</h2>
        {suggestions === null && <div className='skeleton' aria-hidden='true' />}
        {suggestions?.length === 0 && <p className='empty'>{PANTRY_TEXT.emptySuggestions}</p>}
        <div className='actions'>
          {suggestions?.map((s) => {
            const key = `${s.a.bundleId}-${s.b.bundleId}`;
            return (
              <article key={key} className='result-card'>
                <p className='headline'>
                  {s.a.name} ↔ {s.b.name} 같은 상품 같아요
                </p>
                <p className='hint'>
                  지금 표 수 {s.a.votes} · {s.b.votes} → 합친 뒤 {s.votesAfter}표 · 대표 이름 {s.representativeName} · 카탈로그 품목 {s.catalogName ?? '없음'}
                </p>
                <p className='evidence'>{s.source === 'ai' ? <span className='ai-badge'>AI 정리</span> : '이름 규칙'} · 같은 층 열린 요청</p>
                <div className='card-actions'>
                  <button type='button' className='primary' disabled={busy !== null} onClick={() => askMerge(s)}>
                    합치기
                  </button>
                  <button type='button' className='secondary' disabled={busy !== null} onClick={() => void keepApart(s)}>
                    {busy === key ? '따로 두는 중' : '따로 두기'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className='card' aria-label='합친 기록'>
        <h2>합친 기록</h2>
        {records?.length === 0 && <p className='empty'>합친 품목이 없어요.</p>}
        <div className='actions'>
          {records?.map((r) => (
            <article key={r.mergeId} className='result-card'>
              <p className='headline'>
                {r.representativeName} ← {r.mergedName}
              </p>
              <p className='hint'>
                {new Date(r.mergedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' })}에 합쳤어요
              </p>
              <div className='card-actions'>
                <button type='button' className='secondary' onClick={() => askRevert(r)}>
                  되돌리기
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <SettingsSection
        settings={settings}
        onSaved={(saved) => {
          setSettings((all) => all.map((s) => (s.floor === saved.floor ? saved : s)));
          setMessage('저장했어요');
        }}
        onError={(e) => setMessage(e instanceof ApiFailure ? e.message : '저장하지 못했어요')}
      />

      {confirming && (
        <ConfirmSheet
          sheet={confirming.sheet}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              await confirming.run();
              setConfirming(null);
              await reload(false);
            } catch (e) {
              setConfirming(null);
              fail(e);
            }
          }}
        />
      )}
      {message && (
        <Sheet title='결과' onClose={() => setMessage(null)}>
          <p>{message}</p>
        </Sheet>
      )}
    </>
  );
}

/** ④ 설정: 층별 최소 몫·주기당 표 상한·주기 마감 안내(표시용 글자). 층이 하나면 최소 몫 칸을 숨겨요. */
function SettingsSection({ settings, onSaved, onError }: { settings: FloorSetting[]; onSaved: (s: FloorSetting) => void; onError: (e: unknown) => void }) {
  const showMinShare = settings.length > 1;
  return (
    <section className='card' aria-label='설정'>
      <h2>설정</h2>
      <div className='actions'>
        {settings.map((s) => (
          <FloorSettingForm key={s.floor} setting={s} showMinShare={showMinShare} onSaved={onSaved} onError={onError} />
        ))}
      </div>
      <p className='tail'>주기는 주문안을 확정할 때 닫히고 새로 열려요. 주기 마감 안내는 판 머리에 보이는 글자예요.</p>
    </section>
  );
}

function FloorSettingForm({
  setting,
  showMinShare,
  onSaved,
  onError,
}: {
  setting: FloorSetting;
  showMinShare: boolean;
  onSaved: (s: FloorSetting) => void;
  onError: (e: unknown) => void;
}) {
  const [minShare, setMinShare] = useState(String(setting.minShareWon));
  const [limit, setLimit] = useState(String(setting.perPersonLimit));
  const [note, setNote] = useState(setting.cycleNote);
  const [saving, setSaving] = useState(false);
  const noteCheck = note.trim() ? checkItemName(note.trim()) : null;
  const limitNumber = Number(limit);
  const minShareNumber = Number(minShare);
  const invalid =
    !Number.isInteger(limitNumber) ||
    limitNumber < 1 ||
    limitNumber > 50 ||
    !Number.isInteger(minShareNumber) ||
    minShareNumber < 0 ||
    (noteCheck !== null && !noteCheck.ok);

  async function save() {
    setSaving(true);
    try {
      onSaved(await pantryApi.saveSettings(setting.floor, { minShareWon: minShareNumber, perPersonLimit: limitNumber, cycleNote: note.trim() }));
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className='result-card'
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && !saving) void save();
      }}
    >
      <p className='headline'>{setting.floor}</p>
      <div className='card-body'>
        <dl>
          {showMinShare && (
            <div className='field'>
              <dt>
                <label htmlFor={`min-${setting.floor}`}>최소 몫(원)</label>
              </dt>
              <dd>
                <input id={`min-${setting.floor}`} type='number' min={0} step={1000} value={minShare} onChange={(e) => setMinShare(e.target.value)} />
              </dd>
            </div>
          )}
          <div className='field'>
            <dt>
              <label htmlFor={`limit-${setting.floor}`}>주기당 표 상한</label>
            </dt>
            <dd>
              <input id={`limit-${setting.floor}`} type='number' min={1} max={50} value={limit} onChange={(e) => setLimit(e.target.value)} />
            </dd>
          </div>
          <div className='field'>
            <dt>
              <label htmlFor={`note-${setting.floor}`}>주기 마감 안내</label>
            </dt>
            <dd>
              <input id={`note-${setting.floor}`} type='text' maxLength={60} autoComplete='off' value={note} onChange={(e) => setNote(e.target.value)} />
            </dd>
          </div>
        </dl>
        {noteCheck?.message && (
          <p className='lock-line' role='alert'>
            {noteCheck.message}
          </p>
        )}
      </div>
      <div className='card-actions'>
        <button type='submit' className='secondary' disabled={invalid || saving}>
          {saving ? '저장하는 중' : '저장하기'}
        </button>
      </div>
    </form>
  );
}
