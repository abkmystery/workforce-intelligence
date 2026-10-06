import { NextResponse } from 'next/server';
import type { Actor } from '@/lib/types';
import { AppError } from '@/lib/errors';
import { appOrigin } from '@/lib/auth';
import { requireDomain } from './service';

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin || origin !== appOrigin()) throw new AppError(403, 'INVALID_ORIGIN');
}

export function requireTemplateAccess(actor: Actor, domainKey: string): void {
  const domain = requireDomain(domainKey);
  const today = new Date().toISOString().slice(0,10);
  if (!actor.grants.some(grant => (grant.domain === domainKey || grant.domain === '*') && (grant.operation.toUpperCase() === 'IMPORT' || grant.operation === '*') && (grant.dataClass === domain.dataClass || grant.dataClass === '*') && grant.validFrom <= today && (!grant.validTo || grant.validTo > today))) throw new Error('Import permission denied');
}

export function apiError(error: unknown): NextResponse {
  if (error instanceof AppError) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  const message = error instanceof Error ? error.message : 'Request failed';
  const code = /permission|denied|scope|forbidden/i.test(message) ? 'FORBIDDEN' : /unavailable|unknown domain/i.test(message) ? 'NOT_FOUND' : 'BAD_REQUEST';
  return NextResponse.json({ error: { code, message } }, { status: code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : 400, headers: { 'Cache-Control': 'no-store' } });
}
