import assert from 'node:assert/strict';
import path from 'node:path';

// The responsive harness intercepts every write in its in-memory host.
export async function checkUploadsUi(page,{origin,parentId,width,height,output}) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const input=page.getByRole('textbox',{name:'Message Codex',exact:true}); await input.waitFor();
  const pdf=Buffer.alloc(2*1024*1024,32); pdf.write('%PDF-1.4\n');
  await page.locator('input[type=file][aria-label="Choose attachments"]').setInputFiles([
    {name:'report.pdf',mimeType:'application/pdf',buffer:pdf},
    {name:'brief.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('UEsDBA==','base64')}
  ]);
  await page.getByRole('button',{name:'Remove brief.docx',exact:true}).waitFor();
  await input.fill('Review both documents');
  await page.waitForFunction(()=>document.querySelector('.cli-send-button')?.disabled===false);
  await page.evaluate(()=>{window.__holdNextSend=true;window.__heldSendResult=undefined;});
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.locator('.cli-local-queue .is-sending').getByText('Sending…',{exact:true}).waitFor();
  await page.waitForFunction(()=>!!window.__heldSendResult);
  assert.equal(await input.inputValue(),'','Sending moves the message out of the composer');
  const payload=await page.evaluate(()=>window.__uiActions.filter(item=>item.action==='sendCodexCliSessionMessage').at(-1).payload.attachments.map(file=>({name:file.name,kind:file.kind,size:file.size})));
  assert.deepEqual(payload,[{name:'report.pdf',kind:'file',size:pdf.length},{name:'brief.docx',kind:'file',size:4}]);
  await page.evaluate(()=>dispatchEvent(new MessageEvent('message',{data:{...window.__heldSendResult,status:'failed',error:'Document upload was not confirmed.'}})));
  const failed=page.locator('.cli-local-queue .is-failed');
  await failed.getByRole('button',{name:'Resend',exact:true}).waitFor();
  await failed.getByText('report.pdf',{exact:true}).waitFor(); await failed.getByText('brief.docx',{exact:true}).waitFor();
  assert.equal(await input.inputValue(),'','Failure never restores the failed message in the composer');
  await input.fill('Keep this newer draft');
  const bubble=await failed.locator('.cli-session-message').boundingBox(),footer=await failed.locator('.cli-queued-footer').boundingBox();
  assert.ok(footer.y>=bubble.y+bubble.height-1 && footer.height<=40,'Resend is compact directly under the message');
  await page.screenshot({path:path.join(output,`upload-resend-${width}x${height}.png`)});
  await page.evaluate(()=>{window.__holdNextSend=true;window.__heldSendResult=undefined;});
  await failed.getByRole('button',{name:'Resend',exact:true}).click();
  await page.waitForFunction(()=>!!window.__heldSendResult);
  assert.equal(await input.inputValue(),'Keep this newer draft','Resend never changes a newer draft');
  await page.evaluate(()=>dispatchEvent(new MessageEvent('message',{data:{...window.__heldSendResult,status:'failed',error:'Still offline'}})));
  await failed.getByRole('button',{name:'Resend',exact:true}).waitFor();
  await page.waitForFunction(()=>new Promise(resolve=>{const open=indexedDB.open('codex-manager-cache',1);open.onsuccess=()=>{const db=open.result,request=db.transaction('cli-sessions','readonly').objectStore('cli-sessions').getAll();request.onsuccess=()=>{resolve(request.result.some(row=>row.key.startsWith('composer:')&&row.value?.text==='Keep this newer draft'));db.close();};open.onerror=()=>resolve(false);};}));
  await page.reload(); await input.waitFor();
  await page.locator('.cli-local-queue .is-failed').getByRole('button',{name:'Resend',exact:true}).waitFor();
  assert.equal(await input.inputValue(),'Keep this newer draft');
  assert.equal(await page.evaluate(()=>window.__uiActions.filter(item=>item.action==='sendCodexCliSessionMessage').length),0,'Reload never replays a failed upload');
}
