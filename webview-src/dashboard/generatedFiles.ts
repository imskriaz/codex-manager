/** Extract the explicit download links attached to workspace results; never infer files from prose. */
export function generatedWorkspaceFiles(text:string):Array<{path:string;name:string}> {
  const files=new Map<string,{path:string;name:string}>();
  let fenced=false;
  for(const line of text.split('\n')){
    if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}
    if(fenced)continue;
    for(const match of line.matchAll(/\[Download ([^\]\n]+)\]\(([^\s()]+)\?download=1\)/g)){
      let path:string;try{path=decodeURIComponent(match[2]!);}catch{continue;}
      if(/^[a-z][a-z\d+.-]*:|^[/\\]|[\x00-\x1f]/i.test(path)||path.replace(/\\/g,'/').split('/').some(part=>part==='..'||!part))continue;
      files.set(path,{path,name:match[1]!.replace(/\\([\[\]\\])/g,'$1')});
    }
  }
  return [...files.values()];
}
