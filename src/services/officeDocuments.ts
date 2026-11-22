import 'regenerator-runtime/runtime';
import * as path from 'node:path';
import {fork} from 'node:child_process';
import {PDFDocument,type PDFFont} from 'pdf-lib';
import * as fs from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import {Workbook} from 'exceljs';
import {Document,Packer,Paragraph,HeadingLevel} from 'docx';

export async function extractOfficeDocument(name:string,data:Buffer,format:'text'|'html'='text'):Promise<string>{
 const extension=path.extname(name).slice(1).toLowerCase();if(!['xlsx','docx','pdf'].includes(extension))throw new Error('Use an XLSX, DOCX or PDF document.');
 if(data.length>10*1048576)throw new Error('Keep each Office document under 10 MB.');
 if(data.length<8)throw new Error('The document is empty or incomplete.');
 if(extension==='pdf'&&!data.subarray(0,8).toString().startsWith('%PDF-')||extension!=='pdf'&&data.readUInt32LE(0)!==0x04034b50)throw new Error('The document contents do not match its format.');
 return new Promise((resolve,reject)=>{
  // Parser crashes and oversized archives must never take down the dashboard process.
  const worker=fork(path.join(__dirname,'officeDocumentWorker'+path.extname(__filename)),[],{execArgv:['--max-old-space-size=192'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},...{windowsHide:true},stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'});let done=false;
  const finish=(error?:Error,text?:string)=>{if(done)return;done=true;clearTimeout(timer);worker.kill();if(error)reject(error);else resolve(text!);};
  const timer=setTimeout(()=>finish(new Error('Document reading timed out. Try a smaller document.')),12000);
  worker.once('message',(value:{text?:string;error?:string})=>finish(value.error?new Error(value.error):typeof value.text!=='string'?new Error('Document reading did not finish.'):undefined,value.text));
  worker.once('error',()=>finish(new Error('This document is too complex to read. Try a smaller document.')));
  worker.once('exit',()=>{if(!done)finish(new Error('Document reading stopped. Try a smaller document.'));});
  worker.send({extension,data,format},error=>{if(error)finish(new Error('Document reading could not start. Please try again.'));});
 });
}
export async function createOfficeDocument(input:Record<string,unknown>):Promise<Buffer>{
 const name=input['path'];if(typeof name!=='string')throw new Error('Choose a document name.');const extension=path.extname(name).toLowerCase();
 const text=input['text'];if(text!==undefined&&(typeof text!=='string'||text.length>120000))throw new Error('Use up to 120,000 characters for this document.');
 if(extension==='.xlsx'){
  if(!Array.isArray(input['sheets'])||!input['sheets'].length||input['sheets'].length>20)throw new Error('Add one to twenty worksheets.');const book=new Workbook();book.calcProperties.fullCalcOnLoad=true;let cells=0;
  for(const value of input['sheets'] as Array<Record<string,unknown>>){if(!value||typeof value['name']!=='string'||!Array.isArray(value['rows'])||value['rows'].length>5000)throw new Error('Use named worksheets with at most 5,000 rows.');const sheet=book.addWorksheet(value['name'].slice(0,31));
   for(const values of value['rows'] as unknown[]){if(!Array.isArray(values)||values.length>50)throw new Error('Use up to fifty columns.');const row=values.map((cell:unknown)=>{if(++cells>50000)throw new Error('Keep the workbook under 50,000 cells.');if(typeof cell==='number'&&Number.isFinite(cell)||typeof cell==='string'&&cell.length<=8000)return cell;if(cell===null)return null;if(cell&&typeof cell==='object'&&'formula' in cell&&typeof cell.formula==='string'&&cell.formula.length<=1000&&!/[\[\]|]|https?:|WEBSERVICE|HYPERLINK|DDE|RTD|CALL|EXEC|IMAGE\s*\(|IMPORT(?:XML|DATA|HTML|RANGE|FEED)\s*\(/i.test(cell.formula))return {formula:cell.formula.replace(/^=/,'')};throw new Error('Use text, numbers, or a local worksheet formula.');});sheet.addRow(row as never);}
   sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];sheet.columns.forEach(column=>{column.width=22;});
  }return Buffer.from(await book.xlsx.writeBuffer());
 }
 if(typeof text!=='string'||!text.trim())throw new Error('Provide document text.');
 if(extension==='.docx'){const paragraphs=text.split(/\r?\n/).map(line=>new Paragraph({text:line.replace(/^#+\s*/,''),...(line.startsWith('# ')?{heading:HeadingLevel.HEADING_1}:{})}));return Packer.toBuffer(new Document({sections:[{children:paragraphs}]}));}
 if(extension==='.pdf'){
  const document=await PDFDocument.create();document.registerFontkit(fontkit);
  const fonts=await Promise.all(['NotoSans-Regular.ttf','NotoSansBengali-Regular.ttf'].map(async name=>document.embedFont(await fs.readFile(path.join(__dirname,'../../media/fonts',name)),{subset:true})));
  const supported=fonts.map(font=>new Set(font.getCharacterSet()));
  const segmenter=new Intl.Segmenter('bn',{granularity:'grapheme'});
  const runs=(line:string)=>{const result:Array<{font:PDFFont;text:string}>=[];
    for(const part of segmenter.segment(line)){const chars=[...part.segment].map(char=>char.codePointAt(0)!),index=supported.findIndex(set=>chars.every(code=>set.has(code)||code===0x200d||code===0x200c));
      if(index<0)throw new Error('Some characters are not supported by the PDF fonts. Create a DOCX to preserve this language.');
      const font=fonts[index]!,last=result.at(-1);if(last?.font===font)last.text+=part.segment;else result.push({font,text:part.segment});
    }return result;
  };
  const width=(line:string)=>runs(line).reduce((sum,run)=>sum+run.font.widthOfTextAtSize(run.text,11),0);
  let page=document.addPage([595,842]),y=790;
  const write=(line:string)=>{if(y<45){page=document.addPage([595,842]);y=790;}let x=40;for(const run of runs(line)){page.drawText(run.text,{x,y,size:11,font:run.font});x+=run.font.widthOfTextAtSize(run.text,11);}y-=18;};
  for(const paragraph of text.replace(/\t/g,'    ').split(/\r?\n/)){let line='';for(const word of paragraph.split(' ')){
    if(width(line+(line?' ':'')+word)>510&&line){write(line);line='';}
    if(width(word)>510){for(const cluster of segmenter.segment(word)){if(width(line+cluster.segment)>510&&line){write(line);line='';}line+=cluster.segment;}}
    else line+=(line?' ':'')+word;
  }write(line);}

  return Buffer.from(await document.save());
 }
 throw new Error('Create an XLSX, DOCX or PDF document.');
}
