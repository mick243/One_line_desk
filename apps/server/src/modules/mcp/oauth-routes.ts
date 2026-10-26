import { MCP_SCOPES, type McpScope } from '@one-line-desk/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import type { McpAuth } from './auth-service';
import * as repo from './repo';
import { CODE_CHALLENGE_RE, verifyClientSecret } from './tokens';

// 인가 서버 경로(ADR-15): 메타데이터 둘, authorize, token, revoke.
// 동적 등록 엔드포인트는 없어요(/oauth/register·/register는 404). CIMD도 광고하지 않아요.
// OAuth 경로는 RFC 6749대로 모르는 매개변수를 무시해요. 그래서 additionalProperties: false를 두지 않고 손으로 검사해요.

type Form = Map<string, string[]>;

export function registerOauthRoutes(app: FastifyInstance, ctx: AppContext, mcp: McpAuth) {
  const { urls } = mcp;

  // 보호 자원 메타데이터(RFC 9728). resource는 MCP 주소 그대로, 인가 서버는 우리 하나예요.
  const protectedResource = () => ({
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: '한 줄 데스크',
  });
  app.get('/.well-known/oauth-protected-resource/mcp', async () => protectedResource());
  app.get('/.well-known/oauth-protected-resource', async () => protectedResource());

  // 인가 서버 메타데이터(RFC 8414). registration_endpoint와 client_id_metadata_document_supported는 없어요.
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    revocation_endpoint: urls.revoke,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
  }));

  app.get('/oauth/authorize', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const duplicated = Object.values(query).some(Array.isArray);
    const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined);
    // client_id·redirect_uri를 믿을 수 없으면 그 주소로 보내지 않고 우리 화면에서 멈춰요(RFC 6749 4.1.2.1).
    const stop = (error: 'not-allowed' | 'invalid-request') => reply.redirect(`${urls.consent}?error=${error}`, 302);

    const clientId = one('client_id');
    const redirectUri = one('redirect_uri');
    if (duplicated || !clientId || !redirectUri || clientId.length > 100 || redirectUri.length > 500) return stop('invalid-request');
    const client = await repo.findClient(ctx.db, clientId);
    if (!client) return stop('not-allowed');
    if (!client.redirectUris.includes(redirectUri)) return stop('invalid-request');
    if (!mcp.isClientAllowed(client)) return stop('not-allowed');

    const state = one('state');
    const back = (error: string, description: string) =>
      reply.redirect(withParams(redirectUri, { error, error_description: description, state, iss: urls.issuer }), 302);
    if (state !== undefined && state.length > 512) return back('invalid_request', 'state is too long');
    if (one('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
    const challenge = one('code_challenge');
    if (!challenge || one('code_challenge_method') !== 'S256' || !CODE_CHALLENGE_RE.test(challenge)) {
      return back('invalid_request', 'PKCE with S256 is required');
    }
    const resource = one('resource');
    if (!resource) return back('invalid_request', 'resource is required');
    if (resource !== urls.resource) return back('invalid_target', 'resource is not this MCP server');
    const scope = one('scope');
    let scopes: McpScope[] | null = null;
    if (scope !== undefined) {
      const asked = scope.split(' ').filter(Boolean);
      if (!asked.every((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s))) return back('invalid_scope', 'unknown scope');
      scopes = asked.length ? [...new Set(asked)] : null;
    }

    const request = mcp.sealConsentRequest({
      cid: client.clientId,
      ru: redirectUri,
      cc: challenge,
      sc: scopes,
      ...(state !== undefined ? { st: state } : {}),
      rs: resource,
    });
    return reply.redirect(`${urls.consent}?req=${request}`, 302);
  });

  // token·revoke는 application/x-www-form-urlencoded만 받아요. 파서는 이 묶음 안에만 붙여요.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8 * 1024 }, (_req, body, done) => {
      const form: Form = new Map();
      for (const [key, value] of new URLSearchParams(String(body))) form.set(key, [...(form.get(key) ?? []), value]);
      done(null, form);
    });

    scope.post('/oauth/token', async (req, reply) => {
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      const form = formOf(req);
      if (!form) return oauthError(reply, 400, 'invalid_request', 'use application/x-www-form-urlencoded without repeated parameters');
      const client = await authenticateClient(ctx, req, form);
      if (!client) return oauthError(reply.header('www-authenticate', 'Basic realm="one-line-desk"'), 401, 'invalid_client', 'client authentication failed');

      const grantType = form.get('grant_type');
      const result =
        grantType === 'authorization_code'
          ? await mcp.exchangeCode(client, {
              code: form.get('code'),
              redirectUri: form.get('redirect_uri'),
              codeVerifier: form.get('code_verifier'),
              resource: form.get('resource'),
            })
          : grantType === 'refresh_token'
            ? await mcp.refresh(client, { refreshToken: form.get('refresh_token'), scope: form.get('scope'), resource: form.get('resource') })
            : null;
      if (!result) return oauthError(reply, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
      if (!result.ok) return oauthError(reply, result.status, result.error, result.description);
      return result.body;
    });

    scope.post('/oauth/revoke', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const form = formOf(req);
      if (!form) return oauthError(reply, 400, 'invalid_request', 'use application/x-www-form-urlencoded without repeated parameters');
      const client = await authenticateClient(ctx, req, form);
      if (!client) return oauthError(reply.header('www-authenticate', 'Basic realm="one-line-desk"'), 401, 'invalid_client', 'client authentication failed');
      const token = form.get('token');
      if (!token) return oauthError(reply, 400, 'invalid_request', 'token is required');
      await mcp.revoke(client, token);
      return {};
    });
  });
}

/** 한 번씩만 온 매개변수를 꺼내요. 같은 매개변수가 두 번 오면 null이에요(RFC 6749 3.2). */
function formOf(req: FastifyRequest): Map<string, string> | null {
  if (!(req.body instanceof Map)) return null;
  const out = new Map<string, string>();
  for (const [key, values] of req.body as Form) {
    if (values.length !== 1) return null;
    out.set(key, values[0]!);
  }
  return out;
}

/** client_secret_basic 또는 client_secret_post. 등록된 기밀 클라이언트만 받아요. */
async function authenticateClient(ctx: AppContext, req: FastifyRequest, form: Map<string, string>): Promise<repo.ClientRecord | null> {
  let id = form.get('client_id');
  let secret = form.get('client_secret');
  const basic = req.headers.authorization?.match(/^Basic ([A-Za-z0-9+/=]+)$/);
  if (basic) {
    if (secret !== undefined) return null; // 두 방법을 같이 쓰면 거절해요(RFC 6749 2.3).
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    const basicId = formDecode(decoded.slice(0, colon));
    if (id !== undefined && id !== basicId) return null;
    id = basicId;
    secret = formDecode(decoded.slice(colon + 1));
  }
  if (!id || !secret || id.length > 100 || secret.length > 200) return null;
  const client = await repo.findClient(ctx.db, id);
  return client && verifyClientSecret(secret, client.secretHash) ? client : null;
}

function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return value;
  }
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.code(status).send({ error, error_description: description });
}

export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}
