import assert from 'node:assert/strict';

export async function checkSteerUi(page, { origin, parentId }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const input = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.waitFor();
  await page.evaluate(sessionId => {
    const session = window.__uiSessions.find(item => item.id === sessionId);
    Object.assign(session, { status: 'running', steerTurnId: 'turn-fixture' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-steer-owner', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
    window.__steerState = { sessionId, streamId: 'steer-fixture', sequence: 1, turnId: 'turn-fixture', status: 'running', updatedAt: Date.now() + 1000, messages: [] };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
  }, parentId);
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'An empty running composer shows only Stop');
  await input.fill('First steering message');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } })));
  const send = page.locator('.cli-send-button');
  await send.waitFor();
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'Text replaces Stop with a single Send control');
  await page.evaluate(() => { window.__holdNextSteer = true; });
  await send.click();
  await page.waitForFunction(() => window.__heldSteerResult);
  assert.equal(await input.inputValue(), '', 'Steering clears immediately');
  await page.locator('.cli-composer').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'steerCodexCliSessionTurn').length), 1, 'Repeated submit events send only once');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldSteerResult, status: 'failed', error: 'Confirmation lost; verify before retrying.' } })));
  await page.locator('.cli-local-queue').getByRole('button',{name:'Resend',exact:true}).waitFor();
  assert.equal(await input.inputValue(),'','A failed send stays in the conversation without restoring the composer');
  await input.fill('My next draft');
  await page.evaluate(() => {
    window.__steerState = { ...window.__steerState, sequence: 2, updatedAt: Date.now(), messages: [{ id: 'steer-echo', role: 'user', kind: 'message', turnId: 'turn-fixture', text: 'First steering message' }] };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
    window.dispatchEvent(new MessageEvent('message', { data: window.__heldSteerResult }));
  });
  await page.locator('.cli-session-message.is-user').filter({ hasText: 'First steering message' }).waitFor();
  assert.equal(await input.inputValue(), 'My next draft', 'An echo and late acknowledgement preserve newer edits');
  assert.equal(await page.locator('.dashboard-notice').filter({ hasText: /Follow-up sent|Sending message/ }).count(), 0, 'Successful steering adds no information toast');
  await page.evaluate(() => { window.__holdNextSteer = true; window.__heldSteerResult = undefined; });
  await send.click();
  await page.waitForFunction(() => window.__heldSteerResult);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldSteerResult, status: 'failed', error: 'Uncertain result' } }));
  });
  await page.locator('.cli-local-queue').getByRole('button',{name:'Resend',exact:true}).waitFor();
  assert.equal(await input.inputValue(),'','The failed follow-up offers inline Resend');
  await page.evaluate(() => {
    window.__steerState = { ...window.__steerState, sequence: 3, updatedAt: Date.now(), messages: [...window.__steerState.messages, { id: 'second-steer-echo', role: 'user', kind: 'message', turnId: 'turn-fixture', text: 'My next draft' }, { id: 'later-reply', role: 'assistant', kind: 'message', turnId: 'turn-fixture', text: 'Working on the follow-up' }] };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
  });
  await page.waitForFunction(() => document.querySelector('textarea[name="codex-message"]')?.value === '');
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'Clearing a running composer restores only Stop');
  await page.locator('.cli-session-message-text').filter({ hasText: 'Working on the follow-up' }).waitFor();
  const messages = (await page.locator('.cli-session-message-text').allTextContents()).map(text => text.trim());
  assert.ok(messages.indexOf('Working on the follow-up') > messages.indexOf('My next draft'), 'Subsequent output follows the steering message');
  await page.evaluate(sessionId => {
    window.__composerNode = document.querySelector('textarea[name="codex-message"]');
    const session = window.__uiSessions.find(item => item.id === sessionId);
    Object.assign(session, { status: 'running', locked: true, steerTurnId: 'native-follow-up', runningBy: 'another Codex process', updatedAt: new Date(Date.now()+2000).toISOString() });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-native-owner', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
  }, parentId);
  await input.fill('Native owner guidance');
  await page.locator('.cli-composer input[type=file]').setInputFiles({name:'guidance.txt',mimeType:'text/plain',buffer:Buffer.from('Keep this attachment through reconnect')});
  await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
  await send.waitFor();
  assert.equal(await page.locator('.cli-composer-unavailable:visible').count(), 0, 'A verified main Codex turn uses the composer');
  assert.equal(await page.evaluate(() => window.__composerNode === document.querySelector('textarea[name="codex-message"]')), true, 'Switching to native steering keeps the same input');
  for (const status of ['unknown', 'running', 'unknown', 'running']) {
    await page.evaluate(({sessionId,status}) => {
      const session = window.__uiSessions.find(item => item.id === sessionId);
      Object.assign(session, { status, steerTurnId: status === 'unknown' ? undefined : 'native-follow-up', updatedAt: new Date(Date.now()-10000).toISOString() });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-status-refresh', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
    }, {sessionId:parentId,status});
    await page.waitForFunction(status => status === 'unknown'
      ? document.querySelector('.cli-composer-state')?.textContent === 'Checking running state · messages wait locally'
      : !document.querySelector('.cli-composer-state'), status);
    assert.equal(await page.evaluate(() => window.__composerNode === document.querySelector('textarea[name="codex-message"]')), true, 'Status refresh never unmounts the composer');
    assert.equal(await input.inputValue(), 'Native owner guidance', 'Status refresh preserves typed guidance');
    await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
    if(status==='unknown') assert.equal(await send.isEnabled(),true,'Unverified sessions accept a local queued draft without dispatching');
  }
  for (const connected of [false,true]) {
    await page.evaluate(connected => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected } })), connected);
    await page.waitForFunction(connected => connected
      ? !document.querySelector('.cli-composer-state')
      : document.querySelector('.cli-composer-state')?.textContent === 'Offline · messages save locally until reconnect', connected);
    assert.equal(await page.evaluate(() => window.__composerNode === document.querySelector('textarea[name="codex-message"]')), true, 'Reconnect preserves the composer node');
    assert.equal(await input.inputValue(), 'Native owner guidance');
    await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
    if(!connected){
      assert.equal(await send.isEnabled(),true,'Offline messages can save in the local queue');
      const before=await page.evaluate(()=>window.__uiActions.length);
      await input.press('Control+Enter');
      await page.locator('.cli-local-queue .is-queued').waitFor();
      assert.equal(await page.evaluate(()=>window.__uiActions.length),before,'Offline Enter queues without host writes');
      await page.locator('.cli-local-queue').getByRole('button',{name:'Edit',exact:true}).click();
      assert.equal(await input.inputValue(),'Native owner guidance','Editing a queued message restores its text');
      await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
    }
  }
  await page.evaluate(() => { window.__holdNextSteer=true; window.__heldSteerResult=undefined; });
  await send.click();
  await page.waitForFunction(() => !!window.__heldSteerResult);
  const nativeRequest = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'steerCodexCliSessionTurn').at(-1));
  assert.equal(nativeRequest.payload.expectedTurnId, 'native-follow-up', 'Native guidance carries the verified turn for preflight');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldSteerResult })));
  await page.getByRole('button', {name:'Stop',exact:true}).waitFor();
  assert.equal(await page.locator('.cli-send-button:visible,.cli-stop-button:visible').count(),1,'Accepted guidance returns to a single Stop action');

}
