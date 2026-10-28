import { personNameWords } from '@one-line-desk/shared';
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { matchPeople } from './people';
import type { AdapterCapabilities, DirectoryAdapter, EmployeeProfile, IdpAdapter, LoginEvidence, OidcLogin } from './types';

// 임시 IdP(Keycloak) 어댑터(10/26). 로그인은 OIDC 인가 코드 + PKCE, 직원 명단은 관리 API를 명단 읽기 전용 클라이언트로 읽어요.
// 회사 IdP를 흉내 내요: 부서·층·역할은 그룹(/부서/개발팀, /층/5층, /역할/facilities)으로 받아요. 가상 직원이라 띠에는 시연 데이터로 떠요.
// 명단은 몇 분마다 새로 받아 두고(검색·이름 표시), 재직 확인은 그때그때 IdP에 바로 물어요(ADR-13).

export interface KeycloakConfig {
  /** 예: http://localhost:8180/realms/one-line-desk */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** 직원 명단 읽기(관리 API view-users·query-groups만) */
  directoryClientId: string;
  directoryClientSecret: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface KcUser {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled: boolean;
}

type Person = EmployeeProfile & { active: boolean };

const SUBJECT_PREFIX = 'kc|';
const SNAPSHOT_MS = 5 * 60_000;
const PAGE = 200;

/** 그룹 경로 → 부서·층·역할. 모르는 그룹은 버려요. */
export function profileFromGroups(paths: string[]): Pick<EmployeeProfile, 'department' | 'floor' | 'groups'> {
  const pick = (prefix: string) => paths.find((p) => p.startsWith(prefix))?.slice(prefix.length) ?? '';
  return {
    department: pick('/부서/'),
    floor: pick('/층/'),
    groups: paths.filter((p) => p.startsWith('/역할/')).map((p) => p.slice('/역할/'.length)),
  };
}

/** ID 토큰의 인증 근거(amr·acr·auth_time). 모양이 틀린 값은 버려요(ADR-20). */
export function evidenceOf(claims: JWTPayload): LoginEvidence {
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((a): a is string => typeof a === 'string') : typeof claims.amr === 'string' ? [claims.amr] : [];
  return {
    amr,
    ...(typeof claims.acr === 'string' ? { acr: claims.acr } : {}),
    ...(typeof claims.auth_time === 'number' ? { authTime: claims.auth_time * 1000 } : {}),
  };
}

/** 성 자리 + 이름(예: "가상 직원" + "도윤" → "가상 직원 도윤") */
function displayNameOf(last: unknown, first: unknown, fallback: string): string {
  const name = [last, first].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' ');
  return name || fallback;
}

const strip = ({ active: _active, ...profile }: Person): EmployeeProfile => profile;

export class KeycloakAdapter implements IdpAdapter, DirectoryAdapter, OidcLogin {
  readonly capabilities: AdapterCapabilities = { name: 'keycloak', label: '사내 로그인·직원 디렉터리(임시 IdP Keycloak, 가상 직원)', mock: true };
  readonly label = '회사 계정';
  private discovery: Promise<Discovery> | undefined;
  private keys: JWTVerifyGetKey | undefined;
  private serviceToken: { value: string; until: number } | undefined;
  private snapshot: { at: number; people: Person[] } | undefined;

  constructor(
    private readonly cfg: KeycloakConfig,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    /** 시험에서 서명 키를 바로 넘겨요. 없으면 IdP의 jwks_uri에서 받아요. */
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys;
  }

  get oidc(): OidcLogin {
    return this;
  }

  private async meta(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const res = await this.http(`${this.cfg.issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`IdP 설정을 받지 못했어요(${res.status})`);
      const d = (await res.json()) as Discovery;
      if (d.issuer !== this.cfg.issuer) throw new Error('IdP 발급자가 설정과 달라요');
      return d;
    })().catch((e: unknown) => {
      this.discovery = undefined;
      throw e;
    });
    return this.discovery;
  }

  async authorizationUrl(p: Parameters<OidcLogin['authorizationUrl']>[0]): Promise<string> {
    const url = new URL((await this.meta()).authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: p.redirectUri,
      scope: 'openid profile email',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      ...(p.prompt ? { prompt: p.prompt } : {}),
      ...(p.maxAge !== undefined ? { max_age: String(p.maxAge) } : {}),
      ...(p.acrValues ? { acr_values: p.acrValues } : {}),
    }).toString();
    return url.toString();
  }

  async finishLogin(p: {
    code: string;
    codeVerifier: string;
    nonce: string;
    redirectUri: string;
  }): Promise<{ profile: EmployeeProfile; evidence: LoginEvidence } | null> {
    const meta = await this.meta();
    const res = await this.http(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(this.cfg.clientId, this.cfg.clientSecret) },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }),
    });
    // 5xx는 IdP 문제라 던져요(화면이 "회사 로그인에 닿지 못했어요"를 보여요). 4xx는 이 로그인이 틀린 거예요.
    if (res.status >= 500) throw new Error(`IdP 토큰 창구가 답하지 못했어요(${res.status})`);
    if (!res.ok) return null;
    const idToken = ((await res.json()) as { id_token?: unknown }).id_token;
    if (typeof idToken !== 'string') return null;
    this.keys ??= createRemoteJWKSet(new URL(meta.jwks_uri));
    let claims: JWTPayload;
    try {
      claims = (await jwtVerify(idToken, this.keys, { issuer: meta.issuer, audience: this.cfg.clientId, currentDate: new Date(this.now()) })).payload;
    } catch {
      return null;
    }
    if (claims.nonce !== p.nonce || typeof claims.sub !== 'string') return null;
    const groups = Array.isArray(claims.groups) ? claims.groups.filter((g): g is string => typeof g === 'string') : [];
    const profile: EmployeeProfile = {
      idpSubject: SUBJECT_PREFIX + claims.sub,
      displayName: displayNameOf(claims.family_name, claims.given_name, String(claims.preferred_username ?? '직원')),
      ...profileFromGroups(groups),
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    };
    return { profile, evidence: evidenceOf(claims) };
  }

  // ---- 직원 명단(관리 API) ----

  private adminBase(): string {
    const url = new URL(this.cfg.issuer);
    const realm = url.pathname.split('/').filter(Boolean)[1];
    return `${url.origin}/admin/realms/${realm}`;
  }

  private async adminToken(): Promise<string> {
    if (this.serviceToken && this.serviceToken.until > this.now()) return this.serviceToken.value;
    const res = await this.http((await this.meta()).token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(this.cfg.directoryClientId, this.cfg.directoryClientSecret) },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new Error(`직원 명단 토큰을 받지 못했어요(${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.serviceToken = { value: body.access_token, until: this.now() + Math.max(10, (body.expires_in ?? 60) - 30) * 1000 };
    return body.access_token;
  }

  private async admin<T>(path: string): Promise<{ status: number; body: T | null }> {
    const res = await this.http(`${this.adminBase()}${path}`, { headers: { authorization: `Bearer ${await this.adminToken()}` } });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new Error(`직원 명단을 읽지 못했어요(${res.status})`);
    return { status: res.status, body: (await res.json()) as T };
  }

  private async toPerson(u: KcUser): Promise<Person> {
    const groups = (await this.admin<{ path: string }[]>(`/users/${encodeURIComponent(u.id)}/groups?briefRepresentation=true`)).body ?? [];
    return {
      idpSubject: SUBJECT_PREFIX + u.id,
      displayName: displayNameOf(u.lastName, u.firstName, u.username),
      ...profileFromGroups(groups.map((g) => g.path)),
      ...(u.email ? { email: u.email } : {}),
      active: u.enabled,
    };
  }

  /** 명단을 몇 분마다 새로 받아요. IdP가 잠깐 안 되면 지난 명단을 그대로 써요. */
  private async people(force = false): Promise<Person[]> {
    if (!force && this.snapshot && this.now() - this.snapshot.at < SNAPSHOT_MS) return this.snapshot.people;
    try {
      const users: KcUser[] = [];
      for (let first = 0; ; first += PAGE) {
        const page = (await this.admin<KcUser[]>(`/users?briefRepresentation=false&first=${first}&max=${PAGE}`)).body ?? [];
        users.push(...page.filter((u) => !u.username.startsWith('service-account-')));
        if (page.length < PAGE) break;
      }
      const people = await Promise.all(users.map((u) => this.toPerson(u)));
      this.snapshot = { at: this.now(), people };
      return people;
    } catch (e) {
      if (this.snapshot) return this.snapshot.people;
      throw e;
    }
  }

  async getProfile(idpSubject: string): Promise<EmployeeProfile | null> {
    if (!idpSubject.startsWith(SUBJECT_PREFIX)) return null;
    const find = (list: Person[]) => list.find((p) => p.idpSubject === idpSubject);
    const found = find(await this.people()) ?? find(await this.people(true));
    return found ? strip(found) : null;
  }

  async authenticate(idpSubject: string): Promise<EmployeeProfile | null> {
    return (await this.isActive(idpSubject)) ? this.getProfile(idpSubject) : null;
  }

  /** 재직 확인은 명단 사본이 아니라 IdP에 바로 물어요(퇴사 10분 차단, ADR-13). */
  async isActive(idpSubject: string): Promise<boolean> {
    if (!idpSubject.startsWith(SUBJECT_PREFIX)) return false;
    const { body } = await this.admin<KcUser>(`/users/${encodeURIComponent(idpSubject.slice(SUBJECT_PREFIX.length))}`);
    return body?.enabled === true;
  }

  async search(query: string, limit: number): Promise<EmployeeProfile[]> {
    return matchPeople(
      (await this.people()).filter((p) => p.active),
      query,
      limit,
    ).map(strip);
  }

  async personNameWords(): Promise<string[]> {
    return (await this.people()).filter((p) => p.active).flatMap((p) => personNameWords(p.displayName));
  }

  async chartOwnerDepartments(): Promise<Set<string>> {
    // 모의 직원과 같은 임시 값이에요(분장표가 들어오면 navi 서비스가 대신 계산해요).
    return new Set(['재무팀', '인사팀', '총무팀']);
  }
}

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}
