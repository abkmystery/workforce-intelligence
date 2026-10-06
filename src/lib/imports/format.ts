import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { inflateRawSync } from 'node:zlib';
import type { DomainDefinition } from '@/lib/types';

export type ImportFormat = 'csv' | 'xlsx';
export type ParsedRow = { rowNumber: number; values: Record<string, string> };
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_XLSX_EXPANDED_BYTES = 25 * 1024 * 1024;
export const SYSTEM_COLUMNS = ['_id', '_version', '_org_id', '_worker_id', '_valid_from', '_valid_to'] as const;

export function columnsForDomain(domain: DomainDefinition): string[] {
  return [...SYSTEM_COLUMNS, ...Object.keys(domain.fields)];
}

export function safeCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): Buffer {
  const encode = (value: unknown) => {
    const text = safeCell(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return Buffer.from('\uFEFF' + [columns, ...rows.map(row => columns.map(column => row[column]))]
    .map(cells => cells.map(encode).join(',')).join('\r\n') + '\r\n', 'utf8');
}

export async function toXlsx(columns: string[], rows: Record<string, unknown>[], sheetName = 'Data'): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName);
  sheet.addRow(columns);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) sheet.addRow(columns.map(column => safeCell(row[column])));
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function buildTemplate(domain: DomainDefinition, format: ImportFormat, example: boolean): Promise<Buffer> {
  const columns = columnsForDomain(domain);
  const sample: Record<string, unknown> = Object.fromEntries(columns.map(column => [column, column === '_version' ? '1' : '']));
  if (format === 'csv') return toCsv(columns, example ? [sample] : []);
  const book = new ExcelJS.Workbook();
  const data = book.addWorksheet('Data');
  data.addRow(columns);
  if (example) data.addRow(columns.map(column => sample[column]));
  data.getRow(1).font = { bold: true };
  data.views = [{ state: 'frozen', ySplit: 1 }];
  const dictionary = book.addWorksheet('Dictionary');
  dictionary.addRow(['Column', 'Label', 'Type', 'Required', 'Nullable', 'Allowed values', 'Rule']);
  for (const column of SYSTEM_COLUMNS) dictionary.addRow([column, column, column === '_version' ? 'integer' : column.includes('date') ? 'date' : 'uuid', 'No', 'Yes', '', 'Blank means unchanged; <CLEAR> clears nullable fields.']);
  for (const [name, field] of Object.entries(domain.fields)) dictionary.addRow([name, field.label, field.type, field.required ? 'Yes' : 'No', field.nullable ? 'Yes' : 'No', field.options?.join(' | ') ?? '', 'Blank means unchanged; 0 and false are values.']);
  dictionary.getRow(1).font = { bold: true };
  dictionary.columns.forEach(column => { column.width = 25; });
  const instructions = book.addWorksheet('Instructions');
  instructions.addRow(['Template version', '1']);
  instructions.addRow(['Domain', domain.key]);
  instructions.addRow(['Data sheet', 'One row per record. Do not use formulas or links.']);
  instructions.addRow(['Sparse update', 'Omitted or blank cells remain unchanged; <CLEAR> clears nullable fields.']);
  instructions.addRow(['Concurrency', 'UPDATE, ARCHIVE and RESTORE require _id and _version.']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') throw new Error('Rich text, formulas, links and embedded values are not accepted');
  return String(value).trim();
}

// Read ZIP central-directory sizes before ExcelJS allocates decompressed XML.
// ZIP64, encrypted, multi-disk, and malformed archives are deliberately refused.
export function inspectXlsxArchive(bytes: Buffer): void {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  let eocd = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (bytes.readUInt32LE(position) === eocdSignature) { eocd = position; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('XLSX ZIP directory is missing');
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength !== bytes.length) throw new Error('XLSX ZIP trailer is invalid');
  const disks = bytes.readUInt16LE(eocd + 4) + bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const directoryBytes = bytes.readUInt32LE(eocd + 12);
  const directoryStart = bytes.readUInt32LE(eocd + 16);
  if (disks !== 0 || !entries || entries !== entriesOnDisk || entries > 1000 || directoryBytes === 0xffffffff || directoryStart === 0xffffffff || entries === 0xffff) throw new Error('Unsupported XLSX ZIP archive');
  if (directoryStart + directoryBytes > eocd) throw new Error('XLSX ZIP directory is invalid');
  let cursor = directoryStart;
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== centralSignature) throw new Error('XLSX ZIP entry is invalid');
    const flags = bytes.readUInt16LE(cursor + 8);
    const compression = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if ((flags & 1) || ![0,8].includes(compression) || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff || next > eocd) throw new Error('Unsupported XLSX ZIP entry');
    const name = bytes.toString('utf8',cursor + 46,cursor + 46 + nameLength);
    if (!name || name.includes('\0') || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || names.has(name)) throw new Error('Unsafe or duplicate XLSX ZIP path');
    if (/vbaProject\.bin|externalLinks\/|connections\.xml|embeddings\//i.test(name)) throw new Error('Macros, links and embedded content are not accepted');
    names.add(name);
    if (expanded + uncompressed > MAX_XLSX_EXPANDED_BYTES) throw new Error('XLSX expanded content exceeds 25 MiB');
    if (localOffset + 30 > directoryStart || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('XLSX local header is invalid');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    if (payloadStart + compressed > directoryStart || bytes.toString('utf8',localOffset + 30,localOffset + 30 + localNameLength) !== name) throw new Error('XLSX ZIP entry bounds are invalid');
    const payload = bytes.subarray(payloadStart,payloadStart + compressed);
    let actual: number;
    try {
      actual = compression === 0 ? payload.length : inflateRawSync(payload,{ maxOutputLength: MAX_XLSX_EXPANDED_BYTES - expanded + 1 }).length;
    } catch { throw new Error('XLSX expanded content exceeds limit or entry is corrupt'); }
    if (actual !== uncompressed) throw new Error('XLSX ZIP expanded size is invalid');
    expanded += actual;
    cursor = next;
  }
  if (cursor !== directoryStart + directoryBytes) throw new Error('XLSX ZIP directory length is invalid');
}

export async function parseUpload(bytes: Buffer, format: ImportFormat, domain: DomainDefinition, mapping: Record<string, string> = {}): Promise<ParsedRow[]> {
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES) throw new Error('File must be between 1 byte and 5 MiB');
  const allowed = columnsForDomain(domain);
  if (Object.values(mapping).some(value => !allowed.includes(value)) || new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw new Error('Invalid column mapping');
  let matrix: unknown[][];
  if (format === 'csv') {
    if (bytes.subarray(0, 2).equals(Buffer.from('PK')) || bytes.includes(0)) throw new Error('CSV content is not text');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    matrix = parseCsv(source, { skip_empty_lines: true, relax_quotes: false, relax_column_count: false, max_record_size: 50000 }) as unknown[][];
  } else {
    if (!bytes.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('XLSX signature is invalid');
    inspectXlsxArchive(bytes);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as any);
    const sheet = book.getWorksheet('Data');
    if (!sheet) throw new Error('Data sheet is required');
    matrix = [];
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells: unknown[] = [];
      for (let i = 1; i <= row.cellCount; i++) {
        const cell = row.getCell(i);
        if (cell.formula || cell.type === ExcelJS.ValueType.Formula || cell.hyperlink) throw new Error('Formulas and links are not accepted');
        cells.push(cell.value);
      }
      matrix.push(cells);
    });
  }
  if (!matrix.length) throw new Error('Missing header row');
  if (matrix.length - 1 > MAX_IMPORT_ROWS) throw new Error('Import exceeds 5000 rows');
  const headers = matrix[0].map(value => mapping[cellText(value)] ?? cellText(value));
  if (!headers.length || new Set(headers).size !== headers.length || headers.some(header => !header || !allowed.includes(header))) throw new Error('Unknown, empty or duplicate column');
  const seen = new Set<string>();
  return matrix.slice(1).map((cells, index) => {
    if (cells.length > headers.length && cells.slice(headers.length).some(value => cellText(value))) throw new Error(`Row ${index + 2} has extra values`);
    const values = Object.fromEntries(headers.map((header, column) => [header, cellText(cells[column])]));
    for (const value of Object.values(values)) if (/^[\s]*[=+@]/.test(value) || /^[\s]*-(?!\d+(?:\.\d+)?$)/.test(value)) throw new Error(`Row ${index + 2} contains a formula-like value`);
    const identity = JSON.stringify(values);
    if (seen.has(identity)) throw new Error(`Duplicate row at ${index + 2}`);
    seen.add(identity);
    return { rowNumber: index + 2, values };
  }).filter(row => Object.values(row.values).some(Boolean));
}
