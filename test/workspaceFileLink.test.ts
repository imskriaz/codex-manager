import {describe,expect,it} from 'vitest';
import {workspaceFileFromLink, workspaceRelativePath} from '../webview-src/dashboard/workspaceFileLink';

describe('chat file references',()=>{
  it.each([
    ['C:\\Project\\docs\\design.md', 'c:\\project', 'docs/design.md'],
    ['/D:/Project/output/release-plan.md', 'D:\\Project', 'output/release-plan.md'],
    ['file:///C:/Project/docs/design%20draft.md:12', 'C:\\Project', 'docs/design draft.md'],
    ['\\\\?\\C:\\Project\\docs\\design.md', 'C:\\Project', 'docs/design.md'],
    ['/repo/docs/design.md', '/repo', 'docs/design.md'],
    ['/repo-other/secret.md', '/repo', '/repo-other/secret.md'],
    ['docs/design.md', '/repo', 'docs/design.md']
  ])('normalizes file tab %s relative to its project without accepting sibling folders', (file, project, expected) => {
    expect(workspaceRelativePath(file, project)).toBe(expected);
  });
  it.each([
    ['src/main.ts','src/main.ts'],['./README.md#usage','./README.md'],
    ['D:\\Project\\My File.ts:12:3','D:/Project/My File.ts'],
    ['/D:/Project/My%20File.ts:12:3','D:/Project/My File.ts'],
    ['/D:/Project-other/private.md','D:/Project-other/private.md'],
    ['file:///D:/Project/My%20File.ts#L12','D:/Project/My File.ts'],
    ['file:///home/dev/src/main.ts:12','/home/dev/src/main.ts'],
    ['vscode://file/D:/Project/main.ts:12:3','D:/Project/main.ts'],
    ['file://server/share/main.ts','//server/share/main.ts'],
    ['src/main.ts?raw=1','src/main.ts'],['../outside.ts','../outside.ts']
  ])('keeps %s inside the workspace reader', (link,file)=>expect(workspaceFileFromLink(link)).toBe(file));
  it.each(['https://example.com/file.ts','http://example.com','//example.com/file.ts','mailto:test@example.com','javascript:alert(1)','data:text/html,test','#heading','?page=2','file:///tmp/%00secret','file://user:password@host/file',''])('does not reinterpret %s as a file',link=>expect(workspaceFileFromLink(link)).toBeUndefined());
});
