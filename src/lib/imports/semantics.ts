import type { DomainDefinition } from '@/lib/types';
import type { RecordRow } from '@/lib/types';
import type { ParsedRow } from './format';

export type ImportOperation = 'CREATE' | 'UPDATE' | 'UPSERT' | 'ARCHIVE' | 'RESTORE' | 'VALIDATE_ONLY';
export type Mutation = { operation: 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'RESTORE'; id?: string; version?: number; orgId?: string | null; workerId?: string | null; validFrom?: string; validTo?: string | null; data?: Record<string, unknown> };
export type PreparedRow = { rowNumber: number; values: Record<string, string>; mutation: Mutation | null; errors: string[]; diff?: { before: RecordRow | null; after: RecordRow } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string): string {
  if (!date.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
  return value;
}

function parseUuid(value: string): string {
  if (!uuid.test(value)) throw new Error('Invalid UUID');
  return value;
}

export function prepareRow(row: ParsedRow, domain: DomainDefinition, operation: ImportOperation): PreparedRow {
  const errors: string[] = [];
  const values = row.values;
  const target: Mutation['operation'] = operation === 'UPSERT' || operation === 'VALIDATE_ONLY' ? (values._id ? 'UPDATE' : 'CREATE') : operation;
  const mutation: Mutation = { operation: target, data: {} };
  try {
    if (values._id) mutation.id = parseUuid(values._id);
    if (values._version) {
      const version = Number(values._version);
      if (!Number.isInteger(version) || version < 1) throw new Error('Invalid _version');
      mutation.version = version;
    }
    if (target !== 'CREATE' && (!mutation.id || !mutation.version)) errors.push('_id and _version are required');
    if (target === 'CREATE' && mutation.id) errors.push('CREATE cannot supply _id');
    if (values._org_id) mutation.orgId = values._org_id === '<CLEAR>' ? null : parseUuid(values._org_id);
    if (values._worker_id) mutation.workerId = values._worker_id === '<CLEAR>' ? null : parseUuid(values._worker_id);
    if (values._valid_from) mutation.validFrom = parseDate(values._valid_from);
    if (values._valid_to) mutation.validTo = values._valid_to === '<CLEAR>' ? null : parseDate(values._valid_to);
    for (const [key, field] of Object.entries(domain.fields)) {
      const source = values[key];
      if (source === undefined || source === '') {
        if (target === 'CREATE' && field.required) errors.push(`${key} is required`);
        continue;
      }
      if (source === '<CLEAR>') {
        if (!field.nullable) errors.push(`${key} cannot be cleared`);
        else mutation.data![key] = null;
        continue;
      }
      try {
        let value: unknown = source;
        if (field.type === 'uuid') value = parseUuid(source);
        if (field.type === 'date') value = parseDate(source);
        if (field.type === 'number') {
          if (!/^-?(?:\d+)(?:\.\d+)?$/.test(source)) throw new Error('Invalid number');
          value = Number(source);
          if (!Number.isFinite(value as number)) throw new Error('Invalid number');
        }
        if (field.type === 'boolean') {
          if (!['true','false'].includes(source.toLowerCase())) throw new Error('Expected true or false');
          value = source.toLowerCase() === 'true';
        }
        if (field.type === 'select' && !field.options?.includes(source)) throw new Error('Unknown choice');
        mutation.data![key] = value;
      } catch (error) { errors.push(`${key}: ${(error as Error).message}`); }
    }
    if (target === 'CREATE' && !mutation.validFrom) errors.push('_valid_from is required');
    if (mutation.validFrom && mutation.validTo && mutation.validTo <= mutation.validFrom) errors.push('_valid_to must follow _valid_from');
    if ((target === 'ARCHIVE' || target === 'RESTORE') && Object.keys(mutation.data!).length) errors.push(`${target} cannot include field changes`);
  } catch (error) { errors.push((error as Error).message); }
  if (!Object.keys(mutation.data!).length) delete mutation.data;
  return { rowNumber: row.rowNumber, values, mutation: errors.length ? null : mutation, errors };
}
