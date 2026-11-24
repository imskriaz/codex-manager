import assert from 'node:assert/strict';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

export async function checkUserMessageRenderingUi(page, { width, output }) {
  const id = '12345678-1234-1234-1234-123456789abc';
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=';
  const markdown = '# Buyer report\n\n**Important result** and *supporting detail*.\n\n- First item\n- Second item\n\n> Confirmed source.\n\n```json\n{"status":"ready","longValue":"' + 'x'.repeat(500) + '"}\n```\n\n| Buyer | Order | Status | Detail |\n| --- | --- | --- | --- |\n| Example buyer | PO-123 | Ready | ' + 'Long detail '.repeat(30) + ' |\n\n[Source website](https://example.test/reports/2026)\n\nবাংলা প্রতিবেদন: কাজ সম্পন্ন।';
  const fixtures = [
    { id: 'user', kind: 'message', role: 'user', text: 'Check the full workspace presentation.' },
    { id: 'reason', kind: 'reasoning', text: 'Checking the requested details.', status: 'completed' },
    { id: 'plan', kind: 'plan', title: 'Plan', text: 'Plan complete', arguments: JSON.stringify({ steps: [{ step: 'Inspect source', status: 'completed' }, { step: 'Verify report', status: 'completed' }] }), status: 'completed' },
    { id: 'command', kind: 'command', text: 'Check report', command: 'validate-report', output: 'Report checks passed.\n' + 'long-output-'.repeat(100), status: 'completed' },
    { id: 'changes', kind: 'file-change', text: 'Updated report', changes: [{ path: 'reports/result.txt', kind: 'update', diff: '@@ -1 +1 @@\n-old result\n+verified result' }], status: 'completed' },
    { id: 'web', kind: 'tool-call', title: 'Read website', text: 'Source read.', arguments: JSON.stringify({ url: 'https://example.test/reports/2026' }), status: 'completed' },
    { id: 'file', kind: 'tool-call', title: 'Read file', text: 'File read.', arguments: JSON.stringify({ path: 'reports/notes.md' }), status: 'completed' },
    { id: 'skill', kind: 'tool-call', title: 'Use skill · Buyer review', text: 'Review buyer requests.', arguments: JSON.stringify({ id: 'buyer-review', label: 'Buyer review' }), status: 'completed' },
    { id: 'mcp', kind: 'tool-call', title: 'MCP call · orders_query', text: 'Source read.', arguments: JSON.stringify({ connectionId: 'orders', tool: 'orders_query', arguments: { buyer: 'Example', limit: 10 }, api_key: 'private-fixture-key' }), result: JSON.stringify({ count: 42, filename: 'report.xlsx' }), status: 'completed' },
    { id: 'failed', kind: 'tool-call', title: 'Read website', text: 'The source could not be reached.', arguments: JSON.stringify({ url: 'https://example.test/unavailable' }), status: 'failed' },
    { id: 'unknown', kind: 'tool-call', title: 'Update file', text: 'Update pending.', status: 'unknown' },
    { id: 'declined', kind: 'tool-call', title: 'Optional action', text: 'Action declined.', status: 'declined' },
    { id: 'interrupted', kind: 'tool-call', title: 'Stopped action', text: 'Stopped.', status: 'interrupted' },
    { id: 'collaboration', kind: 'collaboration', title: 'Review contribution', text: 'The review checked the report.', status: 'completed' },
    { id: 'search', kind: 'web-search', text: 'Official report query', result: '[Official source](https://example.test/official)', status: 'completed' },
    { id: 'image', kind: 'image', text: 'Report preview', images: [{ src: image, alt: 'Report reference' }], status: 'completed' },
    { id: 'review', kind: 'review', text: '**Review complete.** Figures match the source.', status: 'completed' },
    { id: 'compaction', kind: 'compaction', text: 'Earlier context was summarized.', status: 'completed' },
    { id: 'error', kind: 'error', text: 'The response could not be completed. Retry when connected.', status: 'failed' },
    { id: 'answer', kind: 'message', role: 'assistant', text: markdown }
  ];
  await page.evaluate(({ id, messages }) => localStorage.setItem('private-workspace-fixture', JSON.stringify({ session: { id, title: 'Rendering review', status: 'idle' }, messages })), { id, messages: fixtures });
  await page.goto(new URL('/workspace/' + id, page.url()).href);
  await page.getByText('Buyer report', { exact: true }).waitFor();
  for (const selector of ['.cli-completed-work > summary', '.cli-activity-group-details > summary', '.cli-activity > summary']) {
    for (const summary of await page.locator(selector).all()) if (await summary.isVisible() && !await summary.evaluate(node => node.parentElement.open)) await summary.click();
  }
  for (const kind of ['reasoning', 'command', 'tool-call', 'collaboration', 'web-search', 'image', 'review', 'compaction']) assert.ok(await page.locator('.cli-activity.is-' + kind).count(), kind + ' has a detail surface');
  await page.getByText('The source could not be reached.', { exact: true }).waitFor();
  assert.ok(await page.getByText('Review the activity before retrying.', { exact: false }).count());
  assert.ok(await page.getByText('The response could not be completed. Retry when connected.', { exact: true }).isVisible());
  const transcript = page.locator('.cli-session-messages');
  assert.ok(await transcript.locator('table').count(), 'Markdown tables are rendered');
  assert.ok(await transcript.locator('pre').count(), 'Code and command output have readable surfaces');
  assert.ok(await transcript.getByRole('link', { name: 'Source website', exact: true }).count());
  assert.ok(await transcript.getByRole('link', { name: 'Official source', exact: true }).count());
  assert.ok(await transcript.getByText('বাংলা প্রতিবেদন: কাজ সম্পন্ন।', { exact: true }).count());
  assert.ok(await transcript.getByText('Browse website · https://example.test/reports/2026', { exact: true }).count());
  assert.ok(await transcript.getByText('Use skill · Buyer review', { exact: true }).count());
  assert.ok(await transcript.getByText('MCP call · orders_query', { exact: true }).count());
  assert.match(await transcript.textContent(), /"count"\s*:\s*42/, 'MCP result details are available');
  assert.ok(!(await transcript.textContent()).includes('private-fixture-key'), 'Credentials are removed from activity details');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'All message kinds fit the viewport');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: path.join(output, `message-rendering-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.evaluate(({ id, messages }) => localStorage.setItem('private-workspace-fixture', JSON.stringify({ session: { id, title: 'Rendering review', status: 'running' }, messages: [...messages, { id: 'working', kind: 'tool-call', title: 'Verify result', text: 'Checking the result.', status: 'inProgress' }] })), { id, messages: fixtures });
  await page.reload();
  const working = page.locator('.cli-activity.is-running').filter({ hasText: 'Verify result' });
  await working.waitFor({state:'attached'});
  const group = page.locator('.cli-activity-group.is-running > details > summary');
  if (await group.count() && !await group.evaluate(node => node.parentElement.open)) await group.click();
  await working.locator('summary').click();await working.getByText('Working on this action…', { exact: true }).waitFor();
  await page.evaluate(() => window.__setQuestion(true));
  const question = page.getByRole('dialog', { name: /has a question/ });await question.waitFor();
  assert.equal(await question.locator('fieldset').count(), 3);await question.getByRole('button', { name: 'Close question', exact: true }).click();
  await page.evaluate(() => window.__setQuestion(false));
  console.log(JSON.stringify({ width, messageKinds: 13, allStatuses: true, markdown: true, unicode: true, urlLabels: true, explicitFailures: true, overflow: false }));
}

export async function checkUserFileRenderingUi(page, { width, output, nav }) {
  const pdf = await PDFDocument.create();pdf.addPage([300, 200]).drawText('Verified PDF preview');
  const wav = Buffer.alloc(44 + 800);wav.write('RIFF');wav.writeUInt32LE(wav.length - 8, 4);wav.write('WAVEfmt ', 8);wav.writeUInt32LE(16, 16);wav.writeUInt16LE(1, 20);wav.writeUInt16LE(1, 22);wav.writeUInt32LE(8000, 24);wav.writeUInt32LE(16000, 28);wav.writeUInt16LE(2, 32);wav.writeUInt16LE(16, 34);wav.write('data', 36);wav.writeUInt32LE(800, 40);
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=';
  const fixtures = [
    { path:'notes.md',kind:'text',language:'markdown',content:'# Verified notes\n\n**Readable Markdown** and [source](https://example.test).',mimeType:'text/markdown' },
    { path:'page.html',kind:'text',language:'html',content:'<!doctype html><h1>Verified HTML preview</h1>',mimeType:'text/html' },
    { path:'report.docx',kind:'document',language:'text',content:'<h1>Rendered document</h1><p>'+ 'LongDocumentText'.repeat(100) + '</p><table><tr><td>'+ 'Wide table cell '.repeat(60) + '</td></tr></table>',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { path:'report.pdf',kind:'pdf',language:'text',content:'',dataUrl:'data:application/pdf;base64,'+Buffer.from(await pdf.save()).toString('base64'),mimeType:'application/pdf' },
    { path:'reference.png',kind:'image',language:'text',content:'',dataUrl:image,mimeType:'image/png' },
    { path:'recording.wav',kind:'audio',language:'text',content:'',dataUrl:'data:audio/wav;base64,'+wav.toString('base64'),mimeType:'audio/wav' },
    { path:'clip.webm',kind:'video',language:'text',content:'',dataUrl:'data:video/webm;base64,AA==',mimeType:'video/webm' },
    { path:'archive.zip',kind:'binary',language:'text',content:'',mimeType:'application/zip' }
  ].map(file=>({...file,revision:'preview-r1',size:1024}));
  await page.evaluate(files=>{window.__previewFiles=Object.fromEntries(files.map(file=>[file.path,file]));window.__libraryFiles=files.map(file=>({name:file.path,path:file.path,type:'file',depth:0}));},fixtures);
  for (const file of fixtures) {
    if(width<=760){const hide=page.locator('.cli-context-panel-v3 header').getByRole('button',{name:'Close workspace tools',exact:true});if(await hide.isVisible())await hide.click();}
    await nav('Library');await page.locator('.user-library-files').getByText(file.path,{exact:true}).first().click();
    if(file.path==='page.html') {
      const browser=page.getByRole('region',{name:'Browser',exact:true});await browser.waitFor();
      await browser.getByRole('textbox',{name:'Browser URL',exact:true}).waitFor();
      assert.ok(await page.evaluate(()=>window.__privateActions.some(message=>message.payload?.browserRequest?.url==='page.html')), 'Saved HTML opens through the workspace Browser');
      continue;
    }
    const editor=page.locator('.cli-file-editor');await editor.locator('header strong').filter({hasText:file.path}).waitFor();
    if(file.kind==='document'){
      const frame=editor.locator('iframe');await frame.waitFor();
      const content=page.frameLocator('.cli-file-editor iframe');await content.getByRole('heading',{name:file.kind==='document'?'Rendered document':'Verified HTML preview',exact:true}).waitFor();
      assert.ok(await content.locator('html').evaluate(node=>node.scrollWidth<=innerWidth+2),'Document content fits the file panel');
    }else if(file.kind==='pdf')await editor.locator('iframe').waitFor();
    else if(file.kind==='image'){
      const preview=editor.locator('img');await preview.waitFor();await preview.evaluate(node=>node.dispatchEvent(new Event('error')));await editor.getByRole('alert').filter({hasText:'Image preview could not be loaded.'}).waitFor();
    }else if(file.kind==='audio')await editor.locator('audio[controls]').waitFor();
    else if(file.kind==='video'){
      await editor.locator('video[controls]').waitFor();await editor.locator('video').evaluate(node=>node.dispatchEvent(new Event('error')));await editor.getByRole('alert').waitFor();
    }else if(file.kind==='binary')await editor.getByRole('status').filter({hasText:'A visual preview is not available'}).first().waitFor();
    else await editor.getByRole('heading',{name:'Verified notes',exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'File preview stays inside the viewport');
    await page.screenshot({path:path.join(output,`file-preview-${file.kind}-${file.path.replace(/\W/g,'-')}-${width}.png`),fullPage:true});
  }
  console.log(JSON.stringify({width,fileKinds:7,textAndHtml:true,responsiveDocument:true,pdf:true,imageFailureVisible:true,audio:true,videoFailureVisible:true,binaryFallback:true,overflow:false}));
}
