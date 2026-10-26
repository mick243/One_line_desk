import type {
  BoardResponse,
  FloorSetting,
  MergeResponse,
  MergesResponse,
  MyRequestsResponse,
  PantryDraftResponse,
  PantrySettingsResponse,
  PantrySettingsUpdate,
  SuggestionsResponse,
} from '@one-line-desk/shared';
import { apiRequest } from '../../api';

// 같이 채워요 판 서버 호출. 요청 쓰기 칸 글은 POST 본문으로만 보내요(URL·브라우저 저장소에 안 넣어요, R13).
const floorQuery = (floor?: string) => (floor ? `?floor=${encodeURIComponent(floor)}` : '');

export const pantryApi = {
  draft: (text: string) => apiRequest<PantryDraftResponse>('POST', '/api/pantry/draft', { text }),
  board: (floor?: string) => apiRequest<BoardResponse>('GET', `/api/pantry/board${floorQuery(floor)}`),
  myRequests: () => apiRequest<MyRequestsResponse>('GET', '/api/pantry/my-requests'),
  collect: (floor: string) => apiRequest<SuggestionsResponse>('POST', '/api/pantry/suggestions/collect', { floor }),
  suggestions: (floor: string) => apiRequest<SuggestionsResponse>('GET', `/api/pantry/suggestions${floorQuery(floor)}`),
  merge: (bundleIds: [number, number], versions: [number, number]) => apiRequest<MergeResponse>('POST', '/api/pantry/merges', { bundleIds, versions }),
  keepApart: (bundleIds: [number, number]) => apiRequest<{ changed: number }>('POST', '/api/pantry/suggestions/keep-apart', { bundleIds }),
  merges: (floor: string) => apiRequest<MergesResponse>('GET', `/api/pantry/merges${floorQuery(floor)}`),
  revert: (mergeId: number, bundleVersion: number) => apiRequest<MergeResponse>('POST', `/api/pantry/merges/${mergeId}/revert`, { bundleVersion }),
  settings: () => apiRequest<PantrySettingsResponse>('GET', '/api/pantry/settings'),
  saveSettings: (floor: string, body: PantrySettingsUpdate) => apiRequest<FloorSetting>('PUT', `/api/pantry/settings/${encodeURIComponent(floor)}`, body),
};
