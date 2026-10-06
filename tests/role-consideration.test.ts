import { describe, it, expect } from 'vitest';
import { consideredForRoles } from '../src/lib/role-consideration';
import { validateData } from '../src/lib/validation';

describe('role consideration compatibility and validation', () => {
  it('keeps historical published records considered and never includes archived/unflagged records', () => {
    expect(consideredForRoles({ state: 'active', data: {} })).toBe(true);
    expect(consideredForRoles({ state: 'active', data: { considerForRoles: false } })).toBe(false);
    expect(consideredForRoles({ state: 'archived', data: { considerForRoles: true } })).toBe(false);
  });
  it('rejects string flags and null that could otherwise change matching eligibility', () => {
    const data = { reason: 'Synthetic project ending', availableFrom: '2026-11-01', location: 'Chicago', workMode: 'hybrid', relocationPossible: false, fte: 1 };
    expect(validateData('redeployments', { ...data, considerForRoles: false }).considerForRoles).toBe(false);
    for (const considerForRoles of ['false', 'true', null, 0]) expect(() => validateData('redeployments', { ...data, considerForRoles })).toThrow();
  });
});
