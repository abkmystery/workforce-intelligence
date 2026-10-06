import { describe, it, expect } from 'vitest';
import { placementEvidence } from '../src/lib/matching-contract';

const input = { neededFrom: '2026-11-01', availableFrom: '2026-11-01', placementDeadline: '2026-12-01', requiredSkillIds: ['sql'], verifiedSkillIds: ['sql'], skillsReadable: true,
  needLocation: 'Chicago', location: ' chicago ', needWorkMode: 'hybrid', workMode: 'hybrid', relocationPossible: false, neededFte: 2, headcount: 2, availableFte: 1,
  budget: 120000, currency: 'USD', salaryReadable: true, pay: { amount: 5000, basis: 'monthly', currency: 'USD', paidFte: 0.5 } };
describe('internal placement evidence', () => {
  it('uses inclusive availability, exclusive deadline, per-person FTE and full-time annual base pay', () => {
    expect(placementEvidence(input)).toEqual({ skills: 'All required skills have current verified evidence', dates: 'Available by the requested start', location: 'Location and work mode align',
      fte: 'Available FTE covers one requested person', salary: 'Within annual base salary budget' });
    expect(placementEvidence({ ...input, neededFrom: '2026-12-01' }).dates).toContain('misses the placement deadline');
    expect(placementEvidence({ ...input, availableFrom: '2026-11-02' }).dates).toContain('after');
  });
  it('cannot use hidden salary or skills to imply a fit', () => {
    expect(placementEvidence({ ...input, salaryReadable: false, skillsReadable: false })).toEqual(placementEvidence({ ...input, salaryReadable: false, skillsReadable: false, verifiedSkillIds: [], pay: { ...input.pay, amount: 900000 } }));
    expect(placementEvidence({ ...input, salaryReadable: false }).salary).toBe('Salary permission required');
  });
  it('marks missing pay, currency conversion and hourly normalization for review', () => {
    expect(placementEvidence({ ...input, pay: undefined }).salary).toBe('Salary unknown');
    expect(placementEvidence({ ...input, pay: { ...input.pay, currency: 'EUR' } }).salary).toBe('Currency conversion needed');
    expect(placementEvidence({ ...input, pay: { ...input.pay, basis: 'hourly' } }).salary).toBe('Annual salary needs review');
  });
  it('does not treat unspecified location, remote jurisdiction or unverified skills as proven fits', () => {
    expect(placementEvidence({ ...input, needLocation: undefined }).location).toContain('review');
    expect(placementEvidence({ ...input, workMode: 'remote', needWorkMode: 'remote' }).location).toContain('confirm permitted work location');
    expect(placementEvidence({ ...input, verifiedSkillIds: [] }).skills).toContain('lack current verified evidence');
  });
});
