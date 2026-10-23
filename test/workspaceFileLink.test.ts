import {describe,expect,it} from 'vitest';
import {workspaceFileFromLink} from '../webview-src/dashboard/workspaceFileLink';

describe('chat file references',()=>{
  it.each([
    ['src/main.ts','src/main.ts'],['./README.md#usage','./README.md'],
    ['D:\\Project\\My File.ts:12:3','D:/Project/My File.ts'],
    ['file:///D:/Project/My%20File.ts#L12','D:/Project/My File.ts'],
    ['file:///home/dev/src/main.ts:12','/home/dev/src/main.ts'],
    ['vscode://file/D:/Project/main.ts:12:3','D:/Project/main.ts'],
    ['file://server/share/main.ts','//server/share/main.ts'],
    ['src/main.ts?raw=1','src/main.ts'],['../outside.ts','../outside.ts']
  ])('keeps %s inside the workspace reader', (link,file)=>expect(workspaceFileFromLink(link)).toBe(file));
  it.each(['https://example.com/file.ts','http://example.com','//example.com/file.ts','mailto:test@example.com','javascript:alert(1)','data:text/html,test','#heading','?page=2','file:///tmp/%00secret','file://user:password@host/file',''])('does not reinterpret %s as a file',link=>expect(workspaceFileFromLink(link)).toBeUndefined());
});
