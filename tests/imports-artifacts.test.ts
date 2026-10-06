import { describe, expect, it } from 'vitest';
import { exportStorageKey, MAX_EXPORT_ARTIFACT_BYTES, EXPORT_TTL_HOURS } from '../src/lib/imports/artifacts';

describe('private export artifact boundary', () => {
  it('uses tenant-scoped opaque Blob keys without a public URL', () => {
    const tenant='11111111-1111-4111-8111-111111111111';
    const id='22222222-2222-4222-8222-222222222222';
    expect(exportStorageKey(tenant,id,'csv')).toBe(`${tenant}/${id}.csv`);
    expect(() => exportStorageKey('../other',id,'xlsx')).toThrow(/identity/i);
    expect(MAX_EXPORT_ARTIFACT_BYTES).toBe(25*1024*1024);
    expect(EXPORT_TTL_HOURS).toBe(24);
  });
});
