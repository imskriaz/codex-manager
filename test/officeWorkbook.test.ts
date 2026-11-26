import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { readWorkbook, validateWorkbookRange } from '../src/services/officeWorkbook';
import { extractOfficeDocument } from '../src/services/officeDocuments';
import {MAX_WORKSPACE_FILE_BYTES} from '../src/domain/workspaceFileLimits';

function workbook(sheetXml: string) {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="TNA &amp; Dates" r:id="rId1"/><sheet name="Detail" r:id="rId2"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Detail TNA</t></is></c></row></sheetData></worksheet>');
  zip.file('xl/sharedStrings.xml', '<sst><si><r><t>Buyer </t></r><r><t>&amp; Co</t></r><rPh><t>Phonetic</t></rPh></si></sst>');
  zip.file('xl/styles.xml', '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>');
  return zip;
}

const cells = '<worksheet><dimension ref="A1:BE6000"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>45292</v></c><c r="C1"><f>SUM(D1:E1)</f><v>12</v></c><c r="D1" t="b"><v>0</v></c></row><row r="6000"><c r="BE6000" t="inlineStr"><is><t>Last value</t></is></c></row></sheetData></worksheet>';

it('reads values, dates, rich shared strings and cached formulas without loading ExcelJS', async () => {
  const text = await readWorkbook(workbook(cells), 'text');
  expect(text).toContain('Workbook worksheets: TNA & Dates, Detail');
  expect(text).toContain('A1: Buyer & Co');
  expect(text).not.toContain('Phonetic');
  expect(text).toContain('B1: 2024-01-01T00:00:00.000Z [Excel serial: 45292]');
  expect(text).toContain('C1: 12 [formula: SUM(D1:E1)]');
  expect(text).toContain('D1: FALSE');
  expect(text).toContain('startRow 501');
  expect(text).not.toContain('Last value');
});

it('reads cells beyond the old row and column limits and selects other worksheets', async () => {
  expect(await readWorkbook(workbook(cells), 'text', { worksheet: 'TNA & Dates', startRow: 6000, rowCount: 1, startColumn: 57, columnCount: 1 })).toContain('BE6000: Last value');
  expect(await readWorkbook(workbook(cells), 'text', { worksheet: 'Detail' })).toContain('Detail TNA');
  await expect(readWorkbook(workbook(cells), 'text', { worksheet: 'Missing' })).rejects.toThrow('Worksheet not found');
  expect(await readWorkbook(workbook(cells), 'text', { startRow: 100 })).toContain('No populated cells');
});

it('escapes workbook text in HTML and makes response truncation explicit', async () => {
  const xml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lt;script&gt;unsafe&lt;/script&gt;</t></is></c></row>' + Array.from({length: 30}, (_, index) => `<row r="${index + 2}"><c r="A${index + 2}" t="inlineStr"><is><t>${'x'.repeat(5000)}</t></is></c></row>`).join('') + '</sheetData></worksheet>';
  const text = await readWorkbook(workbook(xml), 'text');
  expect(text).toContain('Excerpt reached the response limit');
  expect(text.length).toBeLessThan(110000);
  const html = await readWorkbook(workbook(xml), 'html');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});

it('rejects invalid ranges, missing shared strings and XML document types', async () => {
  for (const range of [{startRow: 0}, {startRow: NaN}, {rowCount: 5001}, {columnCount: 201}, {worksheet: ''}]) expect(() => validateWorkbookRange(range)).toThrow();
  await expect(readWorkbook(workbook('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>999</v></c></row></sheetData></worksheet>'), 'text')).rejects.toThrow('missing shared text');
  await expect(readWorkbook(workbook('<!DOCTYPE worksheet><worksheet/>'), 'text')).rejects.toThrow('document type');
});
it('preserves Excel text escapes, CDATA and both date calendars', async () => {
  const zip=workbook('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[A&B]]>_x000A__x005F_x0041_</t></is></c><c r="B1" s="1" t="n"><v>60</v></c></row></sheetData></worksheet>');
  expect(await readWorkbook(zip,'text')).toContain('A&B\n_x0041_');
  expect(await readWorkbook(zip,'text')).toContain('fictitious date');
  const xml=await zip.file('xl/workbook.xml')!.async('string');
  zip.file('xl/workbook.xml',xml.replace('<sheets>','<workbookPr date1904="1"/><sheets>'));
  expect(await readWorkbook(zip,'text')).toContain('1904-03-01T00:00:00.000Z');
});

it('extracts a formatting-heavy workbook within the worker deadline and supports ranged reads', async () => {
  const zip = workbook(cells);
  zip.file('xl/drawings/drawing1.xml', '<drawing>' + '<unused/>'.repeat(300000) + '</drawing>');
  const data = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const text = await extractOfficeDocument('TNA-FAL27.xlsx', data, 'text', { worksheet:'TNA & Dates',startRow:6000,rowCount:1,startColumn:57,columnCount:1 });
  expect(text).toContain('Last value');
}, 30000);
it('reads a real 100 MB workbook and rejects a file one byte above the limit', async () => {
  const zip=workbook(cells);zip.file('xl/media/padding.bin',Buffer.alloc(0));
  const overhead=(await zip.generateAsync({type:'nodebuffer',compression:'STORE'})).length;
  zip.file('xl/media/padding.bin',Buffer.alloc(MAX_WORKSPACE_FILE_BYTES-overhead));
  const data=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});
  expect(data.length).toBe(MAX_WORKSPACE_FILE_BYTES);
  const text=await extractOfficeDocument('large.xlsx',data,'text',{worksheet:'Detail'});
  expect(text).toContain('Detail TNA');
  await expect(extractOfficeDocument('too-large.xlsx',Buffer.alloc(MAX_WORKSPACE_FILE_BYTES+1))).rejects.toThrow('100 MB');
},120000);
