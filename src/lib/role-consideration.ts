import type { RecordRow } from './types';

// Existing published placement records were already explicitly listed for matching.
// Preserve those records without rewriting their historical snapshots.
export function consideredForRoles(row: Pick<RecordRow, 'state' | 'data'>): boolean {
  return row.state === 'active' && row.data.considerForRoles !== false;
}

export function considerationPredicate(alias: string): string {
  return `(${alias}.state='active' AND COALESCE((${alias}.data->>'considerForRoles')::boolean,true))`;
}
