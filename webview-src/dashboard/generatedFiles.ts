/** Extract the explicit download links attached to workspace results; never infer files from prose. */
export function generatedWorkspaceFiles(text:string):Array<{path:string;name:string}> {
  const files=new Map<string,{path:string;name:string}>();
  let fenced=false;
  for(const line of text.split('\n')){
    if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}
    if(fenced)continue;
    for(const match of line.matchAll(/\[Download(?:\s+[^\]\n]*)?\]\((?:<([^>\n]+)>|([^\s()]+))\)/gi)){
      const href=match[1]??match[2]!;
      const query=href.indexOf('?');
      if(query<0||new URLSearchParams(href.slice(query+1).split('#')[0]).get('download')!=='1')continue;
      let path:string;try{path=decodeURIComponent(href.slice(0,query)).replace(/\\/g,'/');}catch{continue;}
      if(/^[a-z][a-z\d+.-]*:|^[/\\]|[\x00-\x1f]/i.test(path)||path.split('/').some(part=>part==='..'||part==='.'||!part))continue;
      files.set(path,{path,name:path.split('/').at(-1)!});
    }
  }
  return [...files.values()];
}
