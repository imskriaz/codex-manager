async function work(input:{data:Uint8Array;extension:string;format?:'text'|'html'}){
 const data=Buffer.from(input.data),extension=input.extension;let text='';
 if(extension==='docx'){const mammoth=await import('mammoth');if(input.format==='html'){const html=(await mammoth.convertToHtml({buffer:data})).value;if(html.length<=500000)return html||'<p>This document has no readable content.</p>';}text=(await mammoth.extractRawText({buffer:data})).value;if(input.format==='html')return '<p>Document preview</p><pre style="white-space:pre-wrap;font:inherit">'+text.slice(0,120000).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[char]!)+'</pre>';}
 else if(extension==='xlsx'){
  const module=await import('exceljs');const {Workbook}=('default' in module?module.default:module) as typeof import('exceljs');const book=new Workbook();await book.xlsx.load(data as never);let cells=0;const html:string[]=[];
  const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]!);
  for(const sheet of book.worksheets.slice(0,20)){
    text+='\nSheet: '+sheet.name+'\n';html.push('<h2>'+escape(sheet.name)+'</h2><table>');
    sheet.eachRow((row,index)=>{if(index>5000||cells>=50000||text.length>120000)return;const values:string[]=[],columns:string[]=[];
      for(let column=1;column<=Math.min(50,sheet.columnCount);column++){if(++cells>50000)break;const cell=row.getCell(column),value=cell.text||(cell.formula?'='+cell.formula:'');values.push(cell.address+': '+value+(cell.formula?' [formula: '+cell.formula+']':''));if(index<=500)columns.push('<'+(index===1?'th':'td')+'>'+escape(value).slice(0,8000)+'</'+(index===1?'th':'td')+'>');}
      text+=values.join(' | ')+'\n';if(index<=500)html.push('<tr>'+columns.join('')+'</tr>');
    });html.push('</table>');if(sheet.rowCount>500)html.push('<p>Preview shows the first 500 rows. Download the workbook for all rows.</p>');
  }
  if(input.format==='html')return '<h1>Workbook</h1><p>Formulas without saved results display as formulas. Open in a spreadsheet app to recalculate.</p>'+html.join('');
 }
 else if(extension==='pdf'){const {PDFParse}=await import('pdf-parse');const parser=new PDFParse({data});try{if(input.format==='html'){const result=await parser.getScreenshot({first:3,desiredWidth:900,imageDataUrl:true,imageBuffer:false});const html='<p>Showing '+result.pages.length+' of '+result.total+' pages. Download the PDF for the complete document.</p>'+result.pages.map(page=>'<p>Page '+page.pageNumber+'</p><img style="display:block;width:100%;height:auto" alt="Page '+page.pageNumber+'" src="'+page.dataUrl+'"/>').join('');if(html.length>6000000)throw new Error('Preview too large');return html;}const result=await parser.getText({first:40});text=result.text;}finally{await parser.destroy();}}
 else if(extension==='pptx'){
  const {default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(data);const files=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>Number(a.match(/slide(\d+)\.xml$/)![1])-Number(b.match(/slide(\d+)\.xml$/)![1]));
  if(!files.length||files.length>200||Object.keys(zip.files).length>5000)throw new Error('Presentation is too complex.');
  const decode=(value:string)=>value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/gi,entity=>{const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};if(named[entity])return named[entity]!;const code=entity[2]?.toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);return Number.isInteger(code)&&code>0&&code<=0x10ffff?String.fromCodePoint(code):'';});
  for(const [index,name] of files.entries()){const xml=await zip.file(name)!.async('string');if(xml.length>2000000)throw new Error('Slide is too large.');text+='\nSlide '+(index+1)+'\n'+[...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match=>decode(match[1]!)).join('\n')+'\n';if(text.length>120000)break;}
  if(input.format==='html')return '<h1>Presentation outline</h1><p>Text content only. Download the PPTX to review the original slide layout and media.</p><pre style="white-space:pre-wrap;font:inherit">'+text.slice(0,120000).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[char]!)+'</pre>';
 }
 else throw new Error('This document format is not supported.');
 if(!text.trim())throw new Error('No readable text was found. For a scanned document, attach clear page images for review.');
 return text.length>120000?text.slice(0,120000)+'\n[Document excerpt. Open the original for all content.]':text;
}
process.once('message',(input:{data:Uint8Array;extension:string;format?:'text'|'html'})=>{
 void work(input).then(text=>process.send?.({text},()=>process.disconnect()),(error:unknown)=>process.send?.({error:error instanceof Error&&error.message.startsWith('No readable text was found.')?error.message:'This document could not be read. Try an unencrypted XLSX, DOCX, PPTX or text-based PDF.'},()=>process.disconnect()));
});
