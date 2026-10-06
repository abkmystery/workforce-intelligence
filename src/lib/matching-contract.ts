import Decimal from 'decimal.js';

export type MatchEvidence = { skills: string; dates: string; location: string; fte: string; salary: string };
export type MatchCandidate = { placementId: string; workerId: string; code: string; reason: string; availableFrom: string; placementDeadline: string | null; evidence: MatchEvidence };
export type MatchResult = { requestId: string; code: string; neededFrom: string; asOf: string; page: number; hasMore: boolean; candidates: MatchCandidate[] };
export function placementEvidence(input: {
  neededFrom: string; availableFrom: string; placementDeadline?: string | null;
  requiredSkillIds: string[]; verifiedSkillIds: string[]; skillsReadable: boolean;
  needLocation?: string; location: string; needWorkMode?: string; workMode: string; relocationPossible: boolean;
  neededFte: number; availableFte: number; headcount?: number;
  budget?: number | null; currency?: string; salaryReadable: boolean;
  pay?: { amount: number; currency: string; basis: string; paidFte: number };
}): MatchEvidence {
  const missing = input.requiredSkillIds.filter(id => !input.verifiedSkillIds.includes(id));
  let salary = 'No salary budget specified';
  if (input.budget != null) {
    salary = 'Salary permission required';
    if (input.salaryReadable) {
      const pay = input.pay;
      const multiplier = pay ? ({ annual: 1, monthly: 12, weekly: 52 } as Record<string, number>)[pay.basis] : undefined;
      salary = !pay ? 'Salary unknown' : pay.currency !== input.currency ? 'Currency conversion needed' :
        !multiplier || pay.paidFte <= 0 ? 'Annual salary needs review' :
          new Decimal(pay.amount).times(multiplier).div(pay.paidFte).lte(input.budget) ? 'Within annual base salary budget' : 'Above annual base salary budget';
    }
  }
  const sameLocation = Boolean(input.needLocation?.trim()) && input.needLocation!.trim().toLowerCase() === input.location.trim().toLowerCase();
  let location = 'Location needs review';
  if (input.needWorkMode === 'remote' && input.workMode === 'remote') location = 'Both specify remote; confirm permitted work location';
  else if (sameLocation && (!input.needWorkMode || input.needWorkMode === input.workMode)) location = 'Location and work mode align';
  else if (input.relocationPossible) location = 'Relocation is possible; confirm with the person';
  const perPersonFte = input.headcount && Number.isInteger(input.headcount) && input.headcount > 0 ? input.neededFte / input.headcount : input.neededFte;
  return {
    skills: !input.skillsReadable ? 'Skill evidence permission required' : !input.requiredSkillIds.length ? 'No required skills specified' : missing.length ? `${missing.length} required skill(s) lack current verified evidence` : 'All required skills have current verified evidence',
    dates: input.availableFrom > input.neededFrom ? 'Available after the requested start' : input.placementDeadline && input.neededFrom >= input.placementDeadline ? 'Requested start misses the placement deadline' : 'Available by the requested start',
    location,
    fte: input.availableFte >= perPersonFte ? 'Available FTE covers one requested person' : 'Available FTE is below the requested amount',
    salary,
  };
}
