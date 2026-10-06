import { randomUUID } from 'node:crypto';
import { GraphError, type GraphReader, type GraphPage, GUID, validateGraphUrl } from './client';

export interface DirectoryUser { id: string; displayName?: string | null; mail?: string | null;
  userPrincipalName?: string | null; jobTitle?: string | null; department?: string | null;
  accountEnabled?: boolean; userType?: string; '@removed'?: unknown }
export interface Checkpoint { nextUrl: string | null; deltaUrl: string | null; generation: string; fullScan: boolean }
export interface DirectoryStore {
  checkpoint(): Promise<Checkpoint>;
  reset(generation: string): Promise<void>;
  /** One database transaction: user projections, final reconciliation, and continuation advance. */
  commitPage(users: DirectoryUser[], next: Checkpoint, final: boolean): Promise<void>;
}
export const USERS_PATH = '/v1.0/users/delta';
export const USERS_INITIAL = `https://graph.microsoft.com${USERS_PATH}?$select=id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled,userType`;
export async function synchronizeUsers(graph: GraphReader, store: DirectoryStore): Promise<number> {
  let state = await store.checkpoint();
  let total = 0;
  let resets = 0;
  const seen = new Set<string>();
  while (true) {
    const url = state.nextUrl ?? state.deltaUrl ?? USERS_INITIAL;
    validateGraphUrl(url, USERS_PATH);
    if (seen.has(url)) throw new Error('Graph continuation cycle');
    seen.add(url);
    let page: GraphPage<DirectoryUser>;
    try { page = await graph.get<GraphPage<DirectoryUser>>(url, USERS_PATH); }
    catch (error) {
      if (error instanceof GraphError && error.status === 410 && resets++ === 0) {
        await store.reset(randomUUID()); state = await store.checkpoint(); seen.clear(); continue;
      }
      throw error;
    }
    if (!Array.isArray(page.value) || page.value.some(user => !GUID.test(user.id))) throw new Error('Invalid Graph user page');
    const next = page['@odata.nextLink']; const delta = page['@odata.deltaLink'];
    if (Boolean(next) === Boolean(delta)) throw new Error('Graph page must have exactly one continuation');
    validateGraphUrl((next ?? delta)!, USERS_PATH);
    const final = !next;
    const checkpoint = { ...state, nextUrl: next ?? null, deltaUrl: delta ?? state.deltaUrl,
      fullScan: final ? false : state.fullScan };
    await store.commitPage(page.value, checkpoint, final);
    total += page.value.length;
    state = checkpoint;
    if (final) return total;
  }
}
