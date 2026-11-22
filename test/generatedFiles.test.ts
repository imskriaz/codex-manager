import {expect,it} from 'vitest';
import {generatedWorkspaceFiles} from '../webview-src/dashboard/generatedFiles';
it('presents only explicit relative workspace downloads, deduplicates and ignores code and external URLs',()=>{
 expect(generatedWorkspaceFiles('[Download report.xlsx](reports/report.xlsx?download=1) · [Download report.xlsx](reports/report.xlsx?download=1)\n```\n[Download example.zip](example.zip?download=1)\n```\n[Download wrong.zip](../wrong.zip?download=1) [Download external.zip](https://example.test/file.zip?download=1)')).toEqual([{path:'reports/report.xlsx',name:'report.xlsx'}]);
 expect(generatedWorkspaceFiles('[Download spaced file.pdf](spaced%20file.pdf?download=1) [Download invalid](%zz?download=1)')).toEqual([{path:'spaced file.pdf',name:'spaced file.pdf'}]);
});
