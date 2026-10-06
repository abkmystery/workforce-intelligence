import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import * as oidc from 'openid-client';
import { query, transaction } from './db';
import { AppError } from './errors';
import type { Actor, Grant } from './types';
import { GUID } from './graph/client';
import { materializeLoginGroupGrants } from './graph/login-grants';

const SESSION_COOKIE = '__Host-wi_session';
const LOGIN_COOKIE = '__Host-wi_login';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const deny = () => new AppError(401, 'UNAUTHENTICATED');
export function allowedTenants(): string[] {
  const ids = (process.env.ENTRA_ALLOWED_TENANTS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!ids.length || ids.some(id => !GUID.test(id))) throw new AppError(503, 'ENTRA_NOT_CONFIGURED');
  return ids;
}
export function appOrigin(): string {
  const url = new URL(process.env.APP_URL ?? 'https://localhost:3000');
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError(503, 'HTTPS_REQUIRED');
  return url.origin;
}
export function assertSameOrigin(request: Request): void {
  if (request.headers.get('origin') !== appOrigin()) throw new AppError(403, 'INVALID_ORIGIN');
}
async function configuration(tenantId: string): Promise<oidc.Configuration> {
  if (!allowedTenants().includes(tenantId.toLowerCase())) throw deny();
  const clientId = process.env.ENTRA_CLIENT_ID;
  const secret = process.env.ENTRA_CLIENT_SECRET;
  if (!clientId || !GUID.test(clientId) || !secret) throw new AppError(503, 'ENTRA_NOT_CONFIGURED');
  const config = await oidc.discovery(new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`), clientId, secret);
  // Explicitly verify the ID-token JWS as well as issuer/audience/expiry/nonce.
  oidc.enableNonRepudiationChecks(config);
  return config;
}
export async function createLogin(tenant?: string): Promise<string> {
  const tenantId = (tenant ?? allowedTenants()[0]).toLowerCase();
  const config = await configuration(tenantId);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const browserToken = randomBytes(32).toString('base64url');
  await query('DELETE FROM oauth_transactions WHERE expires_at < now()');
  await query(`INSERT INTO oauth_transactions(token_hash,tenant_id,state,nonce,verifier,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`, [hashToken(browserToken), tenantId, state, nonce, verifier]);
  (await cookies()).set(LOGIN_COOKIE, browserToken, { ...cookieOptions, maxAge: 600 });
  return oidc.buildAuthorizationUrl(config, { redirect_uri: `${appOrigin()}/api/auth/callback`, scope: 'openid profile email',
    response_type: 'code', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce }).href;
}
export async function completeLogin(url: URL): Promise<void> {
  const jar = await cookies();
  const browserToken = jar.get(LOGIN_COOKIE)?.value;
  jar.set(LOGIN_COOKIE, '', { ...cookieOptions, maxAge: 0 });
  if (!browserToken || url.origin !== appOrigin() || url.pathname !== '/api/auth/callback') throw deny();
  const [pending] = await query(`DELETE FROM oauth_transactions WHERE token_hash=$1 AND expires_at>now() RETURNING *`, [hashToken(browserToken)]);
  if (!pending) throw deny();
  const config = await configuration(pending.tenant_id);
  const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: pending.verifier,
    expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || claims.tid !== pending.tenant_id || typeof claims.oid !== 'string' || !GUID.test(claims.oid) ||
      claims.iss !== `https://login.microsoftonline.com/${pending.tenant_id}/v2.0`) throw deny();
  const objectId = claims.oid;
  const roles = Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === 'string') : [];
  const rawToken = randomBytes(32).toString('base64url');
  const hasAccess = await transaction(pending.tenant_id, async tx => {
    const tenant = await tx.query('SELECT id FROM tenants WHERE id=$1', [pending.tenant_id]);
    if (!tenant.rowCount) throw deny();
    const result = await tx.query(`INSERT INTO principals(id,tenant_id,entra_object_id,roles,enabled,auth_version)
      VALUES(gen_random_uuid(),$1,$2,$3,true,1) ON CONFLICT(tenant_id,entra_object_id)
      DO UPDATE SET roles=EXCLUDED.roles,auth_version=CASE WHEN principals.roles IS DISTINCT FROM EXCLUDED.roles
        THEN principals.auth_version+1 ELSE principals.auth_version END RETURNING *`, [pending.tenant_id, objectId, JSON.stringify(roles)]);
    const principal = result.rows[0];
    if (!principal.enabled) throw deny();
    await tx.query(`DELETE FROM access_grants WHERE tenant_id=$1 AND principal_id=$2 AND source='role'`, [pending.tenant_id, principal.id]);
    await tx.query(`INSERT INTO access_grants(id,tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source,source_key)
      SELECT gen_random_uuid(),tenant_id,$2,domain,operation,data_class,org_id,scope,CURRENT_DATE,'role',id::text
      FROM group_mappings WHERE tenant_id=$1 AND enabled=true AND group_id IS NULL AND app_role=ANY($3::text[])`,
      [pending.tenant_id, principal.id, roles]);
    const groupVersion=await materializeLoginGroupGrants(tx,pending.tenant_id,principal.id,objectId);
    if(groupVersion!==null)principal.auth_version=groupVersion;
    await tx.query(`DELETE FROM sessions WHERE tenant_id=$1 AND principal_id=$2 AND auth_version<>$3`,
      [pending.tenant_id,principal.id,principal.auth_version]);
    const grant = await tx.query(`SELECT id FROM access_grants WHERE tenant_id=$1 AND principal_id=$2
      AND valid_from<=CURRENT_DATE AND (valid_to IS NULL OR valid_to>CURRENT_DATE) LIMIT 1`, [pending.tenant_id, principal.id]);
    // Commit verified role revocation even when it leaves the user unable to sign in.
    if (!grant.rowCount) return false;
    await tx.query(`INSERT INTO sessions(id,tenant_id,principal_id,token_hash,expires_at,auth_version,entitlements_checked_at)
      VALUES(gen_random_uuid(),$1,$2,$3,now()+interval '8 hours',$4,now())`,
      [pending.tenant_id, principal.id, hashToken(rawToken), principal.auth_version]);
    return true;
  });
  if (!hasAccess) throw new AppError(403, 'NO_ACCESS_GRANTS');
  jar.set(SESSION_COOKIE, rawToken, { ...cookieOptions, maxAge: 8 * 3600 });
}
export async function actorForSession(token: string): Promise<Actor> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw deny();
  const [row] = await query(`SELECT s.id AS session_id,s.tenant_id,p.id AS principal_id,p.roles,p.auth_version,
    s.entitlements_checked_at FROM sessions s JOIN principals p ON p.id=s.principal_id AND p.tenant_id=s.tenant_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND p.enabled=true AND s.auth_version=p.auth_version`, [hashToken(token)]);
  if (!row) throw deny();
  if (!allowedTenants().includes(String(row.tenant_id).toLowerCase())) throw deny();
  // Mapped group grants fail closed when the directory entitlement snapshot is stale.
  const rows = await transaction(row.tenant_id, async tx => (await tx.query(`SELECT g.domain,g.operation,g.data_class,g.org_id,g.scope,g.valid_from,g.valid_to
    FROM access_grants g WHERE g.tenant_id=$1 AND g.principal_id=$2 AND g.valid_from<=CURRENT_DATE
    AND (g.valid_to IS NULL OR g.valid_to>CURRENT_DATE) AND (COALESCE(g.source,'manual')<>'group' OR EXISTS
      (SELECT 1 FROM graph_entitlement_refresh r WHERE r.tenant_id=g.tenant_id AND r.checked_at>now()-interval '15 minutes'))`, [row.tenant_id, row.principal_id])).rows);
  const grants: Grant[] = rows.map(g => ({ domain: g.domain, operation: g.operation, dataClass: g.data_class,
    orgId: g.org_id, scope: g.scope, validFrom: typeof g.valid_from === 'string' ? g.valid_from : g.valid_from.toISOString().slice(0,10),
    validTo: g.valid_to ? (typeof g.valid_to === 'string' ? g.valid_to : g.valid_to.toISOString().slice(0,10)) : null }));
  if (!grants.length) throw new AppError(403, 'NO_ACCESS_GRANTS');
  return { tenantId: row.tenant_id, userId: row.principal_id, sessionId: row.session_id,
    roles: row.roles ?? [], grants, authVersion: row.auth_version };
}
export async function getActor(): Promise<Actor> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw deny();
  return actorForSession(token);
}
export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
  jar.set(SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0 });
}
