const MAX_ZIP_ENTRIES=5000,MAX_ZIP_ENTRY_BYTES=20*1048576,MAX_ZIP_TOTAL_BYTES=80*1048576;
async function boundedZip(data:Buffer){
 const {default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(data),entries=Object.values(zip.files);
 if(entries.length>MAX_ZIP_ENTRIES)throw new Error('Office archive has too many entries.');
 let total=0;
 for(const entry of entries){
  const size=Number((entry as unknown as {_data?:{uncompressedSize?:number}})._data?.uncompressedSize??0);
  if(!Number.isSafeInteger(size)||size<0||size>MAX_ZIP_ENTRY_BYTES||total>MAX_ZIP_TOTAL_BYTES-size)throw new Error('Office archive is too large to read safely.');
  total+=size;
 }
 return zip;
}
async function work(input:{data:Uint8Array;extension:string;format?:'text'|'html'|'images'|'validate';range?:import('./officeWorkbook').WorkbookReadRange}){
 const data=Buffer.from(input.data),extension=input.extension;let text='';
 const archive=extension==='pdf'?undefined:await boundedZip(data);
 if(input.format==='validate')return 'Document validated.';
 if(extension==='docx'){const mammoth=await import('mammoth');if(input.format==='html'){const html=(await mammoth.convertToHtml({buffer:data})).value;if(html.length<=500000)return html||'<p>This document has no readable content.</p>';}text=(await mammoth.extractRawText({buffer:data})).value;if(input.format==='html')return '<p>Document preview</p><pre style="white-space:pre-wrap;font:inherit">'+text.slice(0,120000).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[char]!)+'</pre>';}
 else if(extension==='xlsx'){
  const reader=await import('./officeWorkbook'+(__filename.endsWith('.ts')?'.ts':'.js')) as typeof import('./officeWorkbook');
  return reader.readWorkbook(archive!,input.format==='html'?'html':'text',input.range);
 }
 else if(extension==='pdf'){const {PDFParse}=await import('pdf-parse');const parser=new PDFParse({data});try{if(input.format==='html'||input.format==='images'){const result=await parser.getScreenshot({first:input.format==='images'?6:3,desiredWidth:900,imageDataUrl:true,imageBuffer:false});if(input.format==='images'){const json=JSON.stringify({total:result.total,pages:result.pages.map(page=>({page:page.pageNumber,image:page.dataUrl}))});if(json.length>12000000)throw new Error('Preview too large');return json;}const html='<p>Showing '+result.pages.length+' of '+result.total+' pages. Download the PDF for the complete document.</p>'+result.pages.map(page=>'<p>Page '+page.pageNumber+'</p><img style="display:block;width:100%;height:auto" alt="Page '+page.pageNumber+'" src="'+page.dataUrl+'"/>').join('');if(html.length>6000000)throw new Error('Preview too large');return html;}const result=await parser.getText({first:40});text=result.text;}finally{await parser.destroy();}}
 else if(extension==='pptx'){
  const zip=archive!;const files=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>Number(a.match(/slide(\d+)\.xml$/)![1])-Number(b.match(/slide(\d+)\.xml$/)![1]));
  if(!files.length||files.length>200||Object.keys(zip.files).length>5000)throw new Error('Presentation is too complex.');
  const decode=(value:string)=>value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/gi,entity=>{const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};if(named[entity])return named[entity]!;const code=entity[2]?.toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);return Number.isInteger(code)&&code>0&&code<=0x10ffff?String.fromCodePoint(code):'';});
  for(const [index,name] of files.entries()){const xml=await zip.file(name)!.async('string');if(xml.length>2000000)throw new Error('Slide is too large.');text+='\nSlide '+(index+1)+'\n'+[...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match=>decode(match[1]!)).join('\n')+'\n';if(text.length>120000)break;}
  if(input.format==='html')return '<h1>Presentation outline</h1><p>Text content only. Download the PPTX to review the original slide layout and media.</p><pre style="white-space:pre-wrap;font:inherit">'+text.slice(0,120000).replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[char]!)+'</pre>';
 }
 else throw new Error('This document format is not supported.');
 if(!text.trim())throw new Error('No readable text was found. For a scanned document, attach clear page images for review.');
 return text.length>120000?text.slice(0,120000)+'\n[Document excerpt. Open the original for all content.]':text;
}
process.once('message',(input:{data:Uint8Array;extension:string;format?:'text'|'html'|'images'|'validate';range?:import('./officeWorkbook').WorkbookReadRange})=>{
 void work(input).then(text=>process.send?.({text},()=>process.disconnect()),(error:unknown)=>process.send?.({error:error instanceof Error&&/^(No readable text was found\.|Office archive |This workbook |Worksheet not found\.|Choose a valid workbook|Choose a valid worksheet)/.test(error.message)?error.message:'This document could not be read. Try an unencrypted XLSX, DOCX, PPTX or text-based PDF.'},()=>process.disconnect()));
});
