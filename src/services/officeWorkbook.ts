import type JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';

export type WorkbookReadRange = { worksheet?: string; startRow?: number; rowCount?: number; startColumn?: number; columnCount?: number };

export function validateWorkbookRange(range: WorkbookReadRange = {}): Required<Omit<WorkbookReadRange, 'worksheet'>> & Pick<WorkbookReadRange, 'worksheet'> {
  if (!range || typeof range !== 'object' || Array.isArray(range) || range.worksheet !== undefined && (typeof range.worksheet !== 'string' || !range.worksheet || range.worksheet.length > 31)) throw new Error('Choose a valid worksheet name.');
  const result = { ...range, startRow: range.startRow ?? 1, rowCount: range.rowCount ?? 500, startColumn: range.startColumn ?? 1, columnCount: range.columnCount ?? 50 };
  for (const [name, maximum] of [['startRow', 1048576], ['rowCount', 5000], ['startColumn', 16384], ['columnCount', 200]] as const) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 1 || result[name] > maximum) throw new Error('Choose a valid workbook row and column range (up to 5,000 rows and 200 columns per read).');
  }
  return result;
}

const localName = (name: string) => name.split(':').at(-1)!;
const decodeText = (value: string) => value.replace(/_x([0-9a-f]{4})_/gi, (_, code: string) => String.fromCharCode(parseInt(code,16)));
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

async function parseXml(zip: JSZip, name: string, parser: SaxesParser<{ xmlns: false }>, stop=()=>false): Promise<void> {
  const file = zip.file(name);
  if (!file) throw new Error('This workbook is missing required worksheet data.');
  const decoder=new StringDecoder('utf8');let bytes=0;
  parser.on('doctype', () => { throw new Error('This workbook contains an unsupported XML document type.'); });
  const source=file.nodeStream('nodebuffer'),stream=new Readable().wrap(source);
  try{for await(const chunk of stream){
      const buffer=chunk as Buffer;bytes+=buffer.length;
      if(bytes>128*1048576)throw new Error('This workbook worksheet exceeds the expanded data limit.');
      parser.write(decoder.write(buffer));
      if(stop())return;
    }
  }finally{source.pause();(source as Readable).destroy();}
  parser.write(decoder.end()).close();
}

export async function readWorkbook(zip: JSZip, format: 'text' | 'html', input?: WorkbookReadRange): Promise<string> {
  const range = validateWorkbookRange(input);
  const relationships = new Map<string, string>(), sheets: Array<{ name: string; id: string }> = [];
  let parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => {
    if (localName(tag.name) !== 'Relationship' || tag.attributes['TargetMode'] === 'External') return;
    const target = tag.attributes['Target'] ?? '';
    const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target));
    if (resolved.startsWith('xl/') && !resolved.includes('\\')) relationships.set(tag.attributes['Id']!, resolved);
  });
  await parseXml(zip, 'xl/_rels/workbook.xml.rels', parser);
  let date1904 = false;
  parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => {
    if (localName(tag.name) === 'workbookPr') date1904 = ['1', 'true'].includes(tag.attributes['date1904'] ?? '');
    if (localName(tag.name) === 'sheet') sheets.push({ name: tag.attributes['name']!, id: Object.entries(tag.attributes).find(([name])=>name.endsWith(':id'))?.[1] ?? '' });
  });
  await parseXml(zip, 'xl/workbook.xml', parser);
  if (!sheets.length) throw new Error('This workbook has no worksheets.');
  const selected = range.worksheet ? sheets.filter(sheet => sheet.name === range.worksheet) : sheets.slice(0, 1);
  if (!selected.length) throw new Error('Worksheet not found. Available worksheets: ' + sheets.map(sheet => sheet.name).join(', '));
  const strings: string[] = [];
  if (zip.file('xl/sharedStrings.xml')) {
    let value = '', inText = false, phonetic = false;
    parser = new SaxesParser({ xmlns: false });
    parser.on('opentag', tag => { const name = localName(tag.name); if (name === 'si') value = ''; if (name === 'rPh') phonetic = true; if (name === 't') inText = true; });
    const append=(text:string)=>{if(inText&&!phonetic)value+=text;};
    parser.on('text',append);parser.on('cdata',append);
    parser.on('closetag', tag => { const name = localName(tag.name); if (name === 't') inText = false; if (name === 'rPh') phonetic = false; if (name === 'si') strings.push(value); });
    await parseXml(zip, 'xl/sharedStrings.xml', parser);
  }
  const dateStyles = new Set<number>(), formats = new Map<number, string>();
  if (zip.file('xl/styles.xml')) {
    let inCellFormats = false, index = 0;
    parser = new SaxesParser({ xmlns: false });
    parser.on('opentag', tag => {
      const name = localName(tag.name);
      if (name === 'numFmt') formats.set(Number(tag.attributes['numFmtId']), tag.attributes['formatCode'] ?? '');
      if (name === 'cellXfs') inCellFormats = true;
      if (name === 'xf' && inCellFormats) {
        const id = Number(tag.attributes['numFmtId']), code = (formats.get(id) ?? '').replace(/"[^"]*"|\\.|\[(?![hms]+\])[^\]]*\]/gi, '');
        if (id >= 14 && id <= 22 || id >= 45 && id <= 47 || /[ymdhis]/i.test(code)) dateStyles.add(index);
        index++;
      }
    });
    parser.on('closetag', tag => { if (localName(tag.name) === 'cellXfs') inCellFormats = false; });
    await parseXml(zip, 'xl/styles.xml', parser);
  }
  const sheet = selected[0]!, target = relationships.get(sheet.id);
  if (!target) throw new Error('This workbook has a missing worksheet relationship.');
  const lines: string[] = [], html: string[] = [];
  let cell: { address: string; type: string; style: number; value: string; formula: string; sharedFormula?: string } | undefined;
  let field = '', dimension = '', truncated = false, textLength = 0, cells = 0;
  let row = 0, column = 0, rowValues: string[] = [], htmlValues: string[] = [], nextRow = range.startRow, finished=false;
  const endRow = Math.min(1048576, range.startRow + range.rowCount - 1), endColumn = Math.min(16384, range.startColumn + range.columnCount - 1);
  parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => {
    const name = localName(tag.name);
    if (name === 'dimension') dimension = tag.attributes['ref'] ?? '';
    if (name === 'row') { row = Number(tag.attributes['r'] ?? row + 1); column = 0; rowValues = []; htmlValues = []; }
    if (name === 'c') {
      const address = tag.attributes['r'] ?? '';
      column = address ? [...address.replace(/\d/g, '')].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) : column + 1;
      if (row >= range.startRow && row <= endRow && column >= range.startColumn && column <= endColumn) cell = { address: address || `Column${column} row${row}`, type: tag.attributes['t'] ?? '', style: Number(tag.attributes['s'] ?? 0), value: '', formula: '' };
    }
    if (cell && ['v', 't', 'f'].includes(name)) { field = name; if (name === 'f' && tag.attributes['t'] === 'shared') cell.sharedFormula = tag.attributes['si']; }
  });
  const append=(text:string)=>{if(cell&&field){if(field==='f')cell.formula+=text;else cell.value+=text;}};
  parser.on('text',append);parser.on('cdata',append);
  parser.on('closetag', tag => {
    const name = localName(tag.name);
    if (['v', 't', 'f'].includes(name)) field = '';
    if (name === 'c' && cell) {
      let value = cell.type === 's' ? strings[Number(cell.value)] : cell.type === 'b' ? cell.value === '1' ? 'TRUE' : 'FALSE' : cell.value;
      if (value === undefined) throw new Error('This workbook references missing shared text.');
      if (['s','inlineStr','str'].includes(cell.type)) value=decodeText(value);
      if ((!cell.type||cell.type==='n') && cell.value !== '' && dateStyles.has(cell.style)) {
        const serial = Number(cell.value), date = new Date((serial - (date1904 ? 24107 : serial < 60 ? 25568 : 25569)) * 86400000);
        if (Number.isFinite(serial) && Number.isFinite(date.getTime())) value = date.toISOString() + ` [Excel serial: ${cell.value}]`;
        if (!date1904&&serial>=60&&serial<61) value=`1900-02-29 [Excel serial: ${cell.value}; fictitious date in Excel's 1900 calendar]`;
      }
      if (cell.formula) value += ` [formula: ${cell.formula}]`;
      else if (cell.sharedFormula !== undefined) value += ` [shared formula: ${cell.sharedFormula}]`;
      if (value) {
        const line = cell.address + ': ' + value;
        if (cells >= 50000 || textLength + line.length > 100000) { truncated = true; nextRow = row; }
        else { cells++; textLength += line.length; rowValues.push(line); htmlValues.push('<td>' + escapeHtml(line) + '</td>'); }
      }
      cell = undefined;
    }
    if (name === 'row' && rowValues.length) { lines.push(rowValues.join(' | ')); html.push('<tr>' + htmlValues.join('') + '</tr>'); }
    if (name === 'row' && (row>=endRow||truncated)) finished=true;
  });
  await parseXml(zip, target, parser,()=>finished);
  const header = `Workbook worksheets: ${sheets.map(value => value.name).join(', ')}\nSheet: ${sheet.name}\nUsed range: ${dimension || 'not declared'}\nRead range: rows ${range.startRow}-${endRow}, columns ${range.startColumn}-${endColumn}. Values include saved formula results; formulas are not recalculated.\n`;
  const notice = truncated ? `\n[Excerpt reached the response limit at row ${nextRow}. Read this worksheet again from that row with fewer rows or columns. Do not treat this excerpt as the complete workbook.]` : `\n[Range complete. For remaining data, use read_file with worksheet ${JSON.stringify(sheet.name)}, startRow ${endRow + 1}, or startColumn ${endColumn + 1}. Read other worksheets by name. Blank and formatting-only cells are omitted.]`;
  return format === 'html' ? '<h1>Workbook</h1><pre>' + escapeHtml(header) + '</pre><table>' + html.join('') + '</table><p>' + escapeHtml(notice) + '</p>' : header + (lines.join('\n') || '[No populated cells in this range.]') + notice;
}
