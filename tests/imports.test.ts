import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { domains } from '../src/lib/registry';
import { buildTemplate, columnsForDomain, parseUpload, toCsv, toXlsx } from '../src/lib/imports/format';
import { prepareRow } from '../src/lib/imports/semantics';

const id = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';

describe('versioned import formats', () => {
  it('creates a usable CSV template for every registered domain', async () => {
    for (const domain of Object.values(domains)) {
      const bytes = await buildTemplate(domain,'csv',false);
      const header = bytes.toString('utf8').replace(/^\uFEFF/,'').split('\r\n')[0];
      expect(header.split(',')).toEqual(columnsForDomain(domain));
    }
  });

  it('creates XLSX Data, Dictionary and Instructions sheets and parses Data', async () => {
    const bytes = await buildTemplate(domains.assignments,'xlsx',true);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as any);
    expect(book.worksheets.map(sheet => sheet.name)).toEqual(['Data','Dictionary','Instructions']);
    expect(book.getWorksheet('Dictionary')?.getRow(1).getCell(1).value).toBe('Column');
    const rows = await parseUpload(bytes,'xlsx',domains.assignments);
    expect(rows).toHaveLength(1);
    expect(rows[0].values._version).toBe('1');
  });

  it('rejects formulas, duplicates and malformed content', async () => {
    const domain = domains.skills;
    await expect(parseUpload(Buffer.from('name\n=2+2\n'),'csv',domain)).rejects.toThrow(/formula/i);
    await expect(parseUpload(Buffer.from('name\nA\nA\n'),'csv',domain)).rejects.toThrow(/Duplicate row/);
    await expect(parseUpload(Buffer.from('name,name\nA,B\n'),'csv',domain)).rejects.toThrow(/duplicate column/i);
    await expect(parseUpload(Buffer.from('name\nA\n'),'xlsx',domain)).rejects.toThrow(/signature/i);
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Data').addRow(['name']);
    book.getWorksheet('Data')!.addRow([{ formula: '1+1', result: 2 }]);
    await expect(parseUpload(Buffer.from(await book.xlsx.writeBuffer()),'xlsx',domain)).rejects.toThrow(/Formula/i);
  });

  it('rejects oversized XLSX expansion from central-directory sizes before parsing', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Data').addRow(['name']);
    book.getWorksheet('Data')!.addRow(['Safe']);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const central = bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    expect(central).toBeGreaterThan(0);
    bytes.writeUInt32LE(30 * 1024 * 1024, central + 24);
    await expect(parseUpload(bytes,'xlsx',domains.skills)).rejects.toThrow(/expanded content/i);
  });

  it('rejects a ZIP entry whose actual expansion exceeds its declared size', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Data').addRow(['name']);
    book.getWorksheet('Data')!.addRow(['Safe']);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const central = bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    expect(central).toBeGreaterThan(0);
    bytes.writeUInt32LE(0, central + 24);
    await expect(parseUpload(bytes,'xlsx',domains.skills)).rejects.toThrow(/expanded size is invalid/i);
  });

  it('escapes spreadsheet injection in both export formats', async () => {
    const csv = toCsv(['value'],[{value:'=HYPERLINK("x")'},{value:'-danger'}]).toString();
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'-danger");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await toXlsx(['value'],[{value:'@SUM(A1)'}]) as any);
    expect(book.getWorksheet('Data')!.getRow(2).getCell(1).value).toBe("'@SUM(A1)");
  });
});

describe('sparse mutation semantics', () => {
  it('keeps omitted and blank cells unchanged while preserving zero and false', () => {
    const row = prepareRow({rowNumber:2,values:{_id:id,_version:'3',fte:'0',managerConfirmed:'false',project:''}},domains.assignments,'UPDATE');
    expect(row.errors).toEqual([]);
    expect(row.mutation).toEqual({operation:'UPDATE',id,version:3,data:{fte:0,managerConfirmed:false}});
  });

  it('allows <CLEAR> only for nullable fields', () => {
    const clear = prepareRow({rowNumber:2,values:{_id:id,_version:'1',expiresOn:'<CLEAR>'}},domains['worker-skills'],'UPDATE');
    expect(clear.mutation?.data).toEqual({expiresOn:null});
    const invalid = prepareRow({rowNumber:3,values:{_id:id,_version:'1',level:'<CLEAR>'}},domains['worker-skills'],'UPDATE');
    expect(invalid.errors).toContain('level cannot be cleared');
    expect(invalid.mutation).toBeNull();
  });

  it('requires concurrency identity and rejects invalid date windows', () => {
    const missing = prepareRow({rowNumber:2,values:{fte:'0.5'}},domains.assignments,'UPDATE');
    expect(missing.errors).toContain('_id and _version are required');
    const invalid = prepareRow({rowNumber:2,values:{_id:id,_version:'2',_valid_from:'2026-09-24',_valid_to:'2026-09-24'}},domains.assignments,'UPDATE');
    expect(invalid.errors).toContain('_valid_to must follow _valid_from');
  });

  it('distinguishes upsert create and update, and checks required create fields', () => {
    const update = prepareRow({rowNumber:2,values:{_id:id,_version:'1',code:'A'}},domains.workers,'UPSERT');
    expect(update.mutation?.operation).toBe('UPDATE');
    const create = prepareRow({rowNumber:3,values:{_org_id:org,_valid_from:'2026-09-24',code:'A',workerType:'employed',employmentStatus:'active',homeOrgId:org}},domains.workers,'UPSERT');
    expect(create.errors).toEqual([]);
    expect(create.mutation?.operation).toBe('CREATE');
    const incomplete = prepareRow({rowNumber:4,values:{_valid_from:'2026-09-24'}},domains.workers,'CREATE');
    expect(incomplete.errors).toContain('code is required');
  });
});
