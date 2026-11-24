import {expect,it} from 'vitest';
import {generatedWorkspaceFiles} from '../webview-src/dashboard/generatedFiles';
it('presents only explicit relative workspace downloads, deduplicates and ignores code and external URLs',()=>{
 expect(generatedWorkspaceFiles('[Download report.xlsx](reports/report.xlsx?download=1) · [Download report.xlsx](reports/report.xlsx?download=1)\n```\n[Download example.zip](example.zip?download=1)\n```\n[Download wrong.zip](../wrong.zip?download=1) [Download external.zip](https://example.test/file.zip?download=1)')).toEqual([{path:'reports/report.xlsx',name:'report.xlsx'}]);
 expect(generatedWorkspaceFiles('[Download spaced file.pdf](spaced%20file.pdf?download=1) [Download invalid](%zz?download=1)')).toEqual([{path:'spaced file.pdf',name:'spaced file.pdf'}]);
});
it('uses the decoded filename rather than a generic or misleading link caption',()=>{
 expect(generatedWorkspaceFiles('[Download file](reports/buyer%20follow-up.txt?download=1) [Download file](costing/order.xlsx?download=1) [Download ZIP](exports/all-files.zip?download=1)')).toEqual([
  {path:'reports/buyer follow-up.txt',name:'buyer follow-up.txt'},
  {path:'costing/order.xlsx',name:'order.xlsx'},
  {path:'exports/all-files.zip',name:'all-files.zip'}
 ]);
 expect(generatedWorkspaceFiles('[download](<reports/Buyer PO (final).pdf?download=1&source=chat>) [Download other](reports%2FBuyer%20PO%20(final).pdf?download=1)')).toEqual([{path:'reports/Buyer PO (final).pdf',name:'Buyer PO (final).pdf'}]);
});
it('normalizes local separators and rejects encoded traversal, absolute paths and non-download links',()=>{
 expect(generatedWorkspaceFiles('[Download file](reports%5Cnotes.txt?download=1) [Download](%2E%2E/private.txt?download=1) [Download](%2Fsecret.txt?download=1) [Download](C%3A%5Csecret.txt?download=1) [Download](./notes.txt?download=1) [Download](https%3A%2F%2Fexample.test/a?download=1) [Download](notes.txt?download=0)')).toEqual([{path:'reports/notes.txt',name:'notes.txt'}]);
});
