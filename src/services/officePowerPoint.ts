/** Shared with the model tool so the advertised layouts match the native generator. */
export const officeSlideSchema = {
  type:'object', properties:{
    title:{type:'string',minLength:1,maxLength:140},
    layout:{type:'string',enum:['bullets','title','section','comparison','timeline','process','metrics','chart']},
    bullets:{type:'array',maxItems:8,items:{type:'string',maxLength:260}},
    notes:{type:'string',maxLength:4000},
    items:{type:'array',description:'comparison: 2-3 items; metrics: 2-4 items with values; timeline/process: 2-5 items with titles under 28 characters and text under 140 characters.',minItems:2,maxItems:5,items:{type:'object',properties:{title:{type:'string',maxLength:60},text:{type:'string',maxLength:240},value:{type:'string',maxLength:24}},required:['title'],additionalProperties:false}},
    chart:{type:'object',properties:{type:{type:'string',enum:['bar','column','line']},labels:{type:'array',minItems:2,maxItems:8,items:{type:'string',maxLength:40}},values:{type:'array',minItems:2,maxItems:8,items:{type:'number'}},seriesName:{type:'string',maxLength:60},unit:{type:'string',maxLength:40}},required:['labels','values'],additionalProperties:false}
  }, required:['title'],additionalProperties:false
} as const;

type Item={title:string;text?:string;value?:string};
type Chart={type?:'bar'|'column'|'line';labels:string[];values:number[];seriesName?:string;unit?:string};
type Slide={title:string;layout?:string;bullets?:string[];notes?:string;items?:Item[];chart?:Chart};
const shortText=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
function readSlide(raw:unknown):Slide {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Provide a slide object.');
  const slide=raw as Slide,layout=slide.layout??'bullets';
  if(!shortText(slide.title,140)||!officeSlideSchema.properties.layout.enum.includes(layout as never))throw new Error('Use a slide title under 140 characters and an available layout.');
  if(slide.notes!==undefined&&(typeof slide.notes!=='string'||slide.notes.length>4000))throw new Error('Keep speaker notes under 4,000 characters.');
  if(slide.bullets!==undefined&&(!Array.isArray(slide.bullets)||slide.bullets.length>8||slide.bullets.some(text=>!shortText(text,260))))throw new Error('Use up to eight short bullets per slide.');
  if(['comparison','timeline','process','metrics'].includes(layout)) {
    const max=layout==='comparison'?3:layout==='metrics'?4:5;
    if(!Array.isArray(slide.items)||slide.items.length<2||slide.items.length>max||slide.items.some(item=>!item||!shortText(item.title,60)||item.text!==undefined&&!shortText(item.text,layout==='comparison'?240:140)||item.value!==undefined&&!shortText(item.value,24)))throw new Error(`Use two to ${max} short labelled items for ${layout}.`);
    if(layout==='metrics'&&slide.items.some(item=>!shortText(item.value,24)))throw new Error('Include a value for each metric.');
  }
  if(['title','section'].includes(layout)&&(slide.bullets?.length??0)>2)throw new Error('Use at most two short lines on title and section slides.');
  if(['title','section'].includes(layout)&&slide.bullets?.some(text=>text.length>160))throw new Error('Keep title and section subtitles under 160 characters.');
  if(['timeline','process'].includes(layout)&&slide.items?.some(item=>item.title.length>28))throw new Error('Keep timeline and process labels under 28 characters.');
  if(layout==='chart') {
    const c=slide.chart;
    if(!c||!['bar','column','line'].includes(c.type??'column')||!Array.isArray(c.labels)||c.labels.length<2||c.labels.length>8||c.labels.some(label=>!shortText(label,40))||!Array.isArray(c.values)||c.values.length!==c.labels.length||c.values.some(value=>typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e15)||c.seriesName!==undefined&&!shortText(c.seriesName,60)||c.unit!==undefined&&!shortText(c.unit,40))throw new Error('Use a chart with two to eight labels, matching finite values and optional units.');
  }
  return {...slide,layout};
}

export async function createOfficePowerPoint(input:Record<string,unknown>):Promise<Buffer> {
  if(!Array.isArray(input['slides'])||!input['slides'].length||input['slides'].length>60)throw new Error('Add one to sixty presentation slides.');
  const slides=input['slides'].map(readSlide);
  const theme=input['theme'];
  if(theme!==undefined&&(!theme||typeof theme!=='object'||Array.isArray(theme)))throw new Error('Use presentation theme colours.');
  const color=(key:string,fallback:string)=>{const value=(theme as Record<string,unknown>|undefined)?.[key]??fallback;if(typeof value!=='string'||!/^[a-f0-9]{6}$/i.test(value))throw new Error('Use six-digit hexadecimal presentation colours.');return value;};
  const background=color('background','F6F5F1'),foreground=color('foreground','20362F'),accent=color('accent','A34532');
  const {default:PptxGenJS}=await import('pptxgenjs');
  const deck=new PptxGenJS();deck.layout='LAYOUT_WIDE';deck.author='';deck.subject='';deck.title=typeof input['title']==='string'?input['title'].slice(0,160):'';
  let page=0;
  for(const value of slides) {
    // Split dense legacy bullet slides instead of shrinking text below a readable size.
    const groups:string[][]=[[]];
    if(value.layout==='bullets')for(const bullet of value.bullets??[]) {
      const lines=(text:string)=>text.split('\n').reduce((sum,line)=>sum+Math.max(1,Math.ceil(line.length/76)),0);
      if(groups.at(-1)!.reduce((sum,text)=>sum+lines(text)+0.6,0)+lines(bullet)>10)groups.push([]);
      groups.at(-1)!.push(bullet);
    }
    for(const [part,bullets] of groups.entries()) {
      const slide=deck.addSlide(),dark=value.layout==='title'||value.layout==='section';
      const ink=dark?background:foreground;slide.background={color:dark?foreground:background};
      const text=(content:string,x:number,y:number,w:number,h:number,fontSize:number,bold=false,color=ink)=>slide.addText(content,{x,y,w,h,fontFace:bold?'Cambria':'Arial',fontSize,bold,color,margin:0,isTextBox:true,breakLine:false,valign:'top'});
      text(value.title+(part?' (continued)':''),0.7,dark?1.35:0.5,11.9,dark?2:1.25,dark?42:32,true);
      if(dark) {
        text((value.bullets??[]).join('\n'),0.75,3.85,10.8,2.2,22);
      } else if(value.layout==='chart') {
        const c=value.chart!;
        slide.addChart(c.type==='line'?deck.ChartType.line:deck.ChartType.bar,[{name:c.seriesName??c.unit??'Value',labels:c.labels,values:c.values}],{
          x:0.85,y:2,w:11.6,h:4.45,barDir:c.type==='bar'?'bar':'col',showLegend:false,showValue:true,showTitle:!!c.unit,title:c.unit,
          titleColor:foreground,titleFontSize:18,catAxisLabelFontSize:16,valAxisLabelFontSize:14,catAxisLabelColor:foreground,valAxisLabelColor:foreground,
          chartColors:[accent],lineDataSymbol:'circle',
          valGridLine:{color:'D7DBD4',size:1},catGridLine:{style:'none'},dataLabelPosition:c.type==='line'?'t':'outEnd',dataLabelColor:foreground,dataLabelFormatCode:'#,##0.##'
        });
      } else if(value.items&&['comparison','timeline','process','metrics'].includes(value.layout!)) {
        const count=value.items.length,gap=0.3,w=(11.9-gap*(count-1))/count;
        if(value.layout==='timeline'||value.layout==='process')slide.addShape(deck.ShapeType.line,{x:0.8,y:2.5,w:11.6,h:0,line:{color:accent,width:2}});
        value.items.forEach((item,index)=>{
          const x=0.7+index*(w+gap),flow=value.layout==='timeline'||value.layout==='process',metric=value.layout==='metrics';
          if(flow){slide.addShape(deck.ShapeType.ellipse,{x:x+0.05,y:2.28,w:0.44,h:0.44,line:{color:accent},fill:{color:background}});text(String(index+1),x+0.14,2.35,0.3,0.3,13,true);}
          else slide.addShape(deck.ShapeType.rect,{x,y:2.05,w,h:4.4,line:{color:foreground,transparency:80},fill:{color:background}});
          if(metric)text(item.value!,x+0.2,2.45,w-0.4,1.2,item.value!.length>12?28:40,true,accent);
          text(item.title,x+0.2,metric?3.85:flow?3:2.4,w-0.4,1.1,22,true);
          if(item.text)text(item.text,x+0.2,metric?5:flow?4.2:3.7,w-0.4,metric?1.1:2.5,18);
        });
      } else {
        let y=2.05;
        bullets.forEach((bullet,index)=>{
          const lines=bullet.split('\n').reduce((sum,line)=>sum+Math.max(1,Math.ceil(line.length/76)),0),h=lines*0.34+0.16;
          text(String(index+1).padStart(2,'0'),0.75,y,0.6,0.4,18,true,accent);text(bullet,1.55,y,10.9,h,20);y+=h+0.16;
        });
      }
      text(String(++page),12,7,0.6,0.25,11);
      if(value.notes)slide.addNotes(value.notes);
    }
  }
  return Buffer.from(await deck.write({outputType:'nodebuffer'}) as Buffer);
}
