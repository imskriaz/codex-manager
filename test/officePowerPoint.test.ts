import {expect,it} from 'vitest';
import JSZip from 'jszip';
import {createOfficeDocument} from '../src/services/officeDocuments';
import {officeGenerationFailure,OfficeCapacityError,OfficeResponseError} from '../src/domain/officeGenerationFailure';

it('generates editable charts, comparisons, timelines and metrics with notes',async()=>{
 const data=await createOfficeDocument({path:'brief.pptx',slides:[
  {title:'Decision brief',layout:'title',bullets:['Verified evidence for the next decision']},
  {title:'Compare options',layout:'comparison',items:[{title:'Current',text:'Existing arrangement'},{title:'Proposed',text:'Requested change'}]},
  {title:'Milestones',layout:'timeline',items:[{title:'Review',text:'Confirm evidence'},{title:'Decision',text:'Agree next steps'}]},
  {title:'Measured results',layout:'metrics',items:[{title:'Factories',value:'12',text:'Illustrative count'},{title:'Days',value:'3',text:'Illustrative duration'}]},
  {title:'Wage comparison',layout:'chart',chart:{labels:['Current','Requested'],values:[12500,30000],unit:'BDT per month'},notes:'Source: https://example.test/wages'}
 ]});
 const zip=await JSZip.loadAsync(data,{checkCRC32:true}),names=Object.keys(zip.files);
 expect(names.filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(5);
 const chart=await zip.file('ppt/charts/chart1.xml')!.async('string');expect(chart).toContain('12500');expect(chart).toContain('30000');expect(chart).toContain('BDT per month');
 expect(await zip.file('ppt/slides/slide5.xml')!.async('string')).toContain('graphicFrame');
 expect(await zip.file('ppt/notesSlides/notesSlide5.xml')!.async('string')).toContain('https://example.test/wages');
 for(const name of names.filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)))expect(await zip.file(name)!.async('string')).toContain('txBox="1"');
});
it('splits dense legacy bullet slides without losing content',async()=>{
 const bullets=Array.from({length:8},(_,i)=>`${i}: `+'Evidence and explanation. '.repeat(9));
 const zip=await JSZip.loadAsync(await createOfficeDocument({path:'dense.pptx',slides:[{title:'Detailed evidence',bullets}]}));
 const slides=await Promise.all(Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name=>zip.file(name)!.async('string')));
 expect(slides.length).toBeGreaterThan(1);for(const bullet of bullets)expect(slides.join('')).toContain(bullet);
});
it.each([
 {title:'Bad chart',layout:'chart',chart:{labels:['A','B'],values:[1]}},
 {title:'Bad value',layout:'chart',chart:{labels:['A','B'],values:[1,Infinity]}},
 {title:'Overcrowded',layout:'comparison',items:Array.from({length:5},()=>({title:'Card'}))},
 {title:'Missing metric',layout:'metrics',items:[{title:'A'},{title:'B'}]}
])('rejects invalid layout data before saving a PowerPoint',async slide=>{
 await expect(createOfficeDocument({path:'invalid.pptx',slides:[slide]})).rejects.toThrow();
});
it('honors an HTTP-date retry delay and keeps malformed-output diagnostics distinct from capacity',()=>{
 const later=new Date(Date.now()+120000).toUTCString();
 const limited=officeGenerationFailure(429,'rate_limit_error',later,false);expect(limited).toBeInstanceOf(OfficeCapacityError);expect((limited as OfficeCapacityError).retryAfterMs).toBeGreaterThan(118000);
 expect(officeGenerationFailure(502,'invalid_tool_call',null,false)).toBeInstanceOf(OfficeResponseError);
 expect(officeGenerationFailure(504,'request_timeout',null,false).message).toContain('timed out');
 expect(officeGenerationFailure(429,'rate_limit_error',null,true)).not.toBeInstanceOf(OfficeCapacityError);
});
