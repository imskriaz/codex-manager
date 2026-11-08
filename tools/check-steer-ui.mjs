import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkSteerUi(page, { origin, parentId, output, width }) {
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
  assert.equal(await page.locator('.cli-goal-strip:not(.cli-queued-message) > summary > small').innerText(), '2M', 'Goal time uses compact uppercase duration units');
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'An empty running composer shows only Stop');
  await input.fill('First steering message');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } })));
  const send = page.locator('.cli-send-button');
  await send.waitFor();
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'Text replaces Stop with a single Send control');
  await page.evaluate(() => { window.__holdNextSteer = true; });
  await send.click();
  await page.waitForFunction(() => window.__heldSteerResult);
  assert.equal(await page.locator('.cli-queued-message.is-sending').getByRole('button', { name: 'Edit queued message', exact: true }).count(), 0, 'In-flight guidance hides its unavailable Edit action');
  const matchingRows = await page.evaluate(() => {
    const read = selector => {
      const row = document.querySelector(selector), summary = row.querySelector(':scope > summary');
      const box = row.getBoundingClientRect(), style = getComputedStyle(row), header = getComputedStyle(summary);
      return { x: box.x, width: box.width, height: box.height, font: style.fontSize, color: style.color, background: style.backgroundColor, border: style.border, radius: style.borderRadius, padding: header.padding, gap: header.gap };
    };
    return { goal: read('.cli-goal-strip:not(.cli-queued-message)'), queue: read('.cli-queued-message.is-sending') };
  });
  assert.deepEqual(matchingRows.queue, matchingRows.goal, 'Queue and Steer use the exact goal row geometry and visual styles');
  const iconSizes = await page.evaluate(() => {
    const size = selector => { const style = getComputedStyle(document.querySelector(selector)); return { width: style.width, height: style.height }; };
    return { goal: size('.cli-goal-strip:not(.cli-queued-message) .cli-goal-mark svg'), queue: size('.cli-queued-message .cli-goal-mark svg'), spinner: size('.cli-queued-message .cli-live-spinner') };
  });
  assert.deepEqual(iconSizes.queue, iconSizes.goal, 'Queue icons match goal icons');
  assert.deepEqual(iconSizes.spinner, iconSizes.goal, 'The single sending spinner matches goal icon dimensions');
  await page.screenshot({ path: path.join(output, `queue-goal-${width}.png`), animations: 'disabled' });
  const pendingRow = page.locator('.cli-queued-message.is-sending');
  await pendingRow.locator(':scope > summary').click();
  assert.equal(await pendingRow.evaluate(row => row.open), true, 'Queued text expands like a goal');
  await pendingRow.locator(':scope > summary').click();
  assert.equal(await input.inputValue(), '', 'Steering clears immediately');
  await page.locator('.cli-composer').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'steerCodexCliSessionTurn').length), 1, 'Repeated submit events send only once');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldSteerResult, status: 'failed', error: 'Confirmation lost; verify before retrying.' } })));
  await page.locator('.cli-queued-message.is-failed').last().getByRole('button',{name:'Resend queued message',exact:true}).waitFor();
  const controlSizes = await page.evaluate(() => {
    const size = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { width: box.width, height: box.height }; };
    return { goal: size('.cli-goal-strip:not(.cli-queued-message) .cli-goal-control'), queue: size('.cli-queued-message .cli-goal-control') };
  });
  assert.deepEqual(controlSizes.queue, controlSizes.goal, 'Queue controls use the same desktop and touch sizes as goal controls');
  await page.keyboard.press('Escape');
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
  await page.locator('.cli-queued-message.is-failed').last().getByRole('button',{name:'Resend queued message',exact:true}).waitFor();
  await page.keyboard.press('Escape');
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
  await input.fill('Fast accepted steering');
  await send.click();
  await page.locator('.cli-session-message.is-user').filter({ hasText: 'Fast accepted steering' }).waitFor();
  assert.equal(await page.locator('.cli-session-message.is-user').filter({ hasText: 'Fast accepted steering' }).count(), 1, 'Accepted guidance appears immediately without waiting for an owner echo');
  assert.equal(await page.locator('.cli-local-queue .is-sending').count(), 0, 'Accepted guidance stops showing a pending send');
  await page.evaluate(sessionId => {
    window.__composerNode = document.querySelector('textarea[name="codex-message"]');
    window.__steerState = { ...window.__steerState, sequence: 4, status: 'disconnected', updatedAt: Date.now() };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
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
      Object.assign(session, { status, steerTurnId: status === 'unknown' ? undefined : 'native-follow-up', updatedAt: new Date(Date.now()+3000).toISOString() });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-status-refresh', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
    }, {sessionId:parentId,status});
    await page.waitForFunction(status => status === 'unknown'
      ? document.querySelector('.cli-composer .sr-only[role="status"]')?.textContent === 'Checking running state · messages wait locally'
      : document.querySelector('.cli-composer .sr-only[role="status"]')?.textContent !== 'Checking running state · messages wait locally', status);
    assert.equal(await page.evaluate(() => window.__composerNode === document.querySelector('textarea[name="codex-message"]')), true, 'Status refresh never unmounts the composer');
    assert.equal(await input.inputValue(), 'Native owner guidance', 'Status refresh preserves typed guidance');
    await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
    if(status==='unknown') assert.equal(await send.isEnabled(),true,'Unverified sessions accept a local queued draft without dispatching');
  }
  for (const connected of [false,true]) {
    await page.evaluate(connected => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected } })), connected);
    await page.waitForFunction(connected => connected
      ? !document.querySelector('.cli-workspace')?.hasAttribute('disabled')
      : document.querySelector('.cli-workspace')?.hasAttribute('disabled'), connected);
    assert.equal(await page.evaluate(() => window.__composerNode === document.querySelector('textarea[name="codex-message"]')), true, 'Reconnect preserves the composer node');
    assert.equal(await input.inputValue(), 'Native owner guidance');
    await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
    if(!connected){
      assert.equal(await input.isDisabled(),true,'Offline composer actions are disabled');
      const before=await page.evaluate(()=>window.__uiActions.length);
      await input.press('Control+Enter');
      assert.equal(await page.locator('.cli-local-queue').getByRole('button',{name:'Resend queued message',exact:true}).count(),0,'Offline queued messages do not offer Resend');
      assert.equal(await input.getAttribute('placeholder'),'Message Codex…','Connection status keeps the default composer placeholder');
      assert.equal(await page.evaluate(()=>window.__uiActions.length),before,'Offline input sends no host actions');
      assert.equal(await input.inputValue(),'Native owner guidance','Offline actions preserve the draft');
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
  await page.evaluate(() => {
    window.__steerState = { ...window.__steerState, sequence: 5, status: 'running', updatedAt: Date.now() + 5000, tokenUsage: { input: 276906687, cachedInput: 272657408, output: 251524, reasoningOutput: 96616, total: 277158211, contextWindow: 475000 } };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
  });
  const showTools = page.getByRole('button', { name: 'Show workspace tools', exact: true });
  if (await showTools.isVisible()) await showTools.click();
  await page.getByRole('tab', { name: 'Env', exact: true }).click();
  const usage = page.locator('.cli-inspector-view .cli-usage-grid');
  await usage.waitFor();
  assert.deepEqual(await usage.locator('strong').allTextContents(), ['276.9M', '272.7M', '251.5K', '96.6K', '277.2M', '475K'], 'Every usage counter uses compact suffixes');
  assert.equal(await usage.locator('> span').first().getAttribute('title'), 'Input: 276,906,687 tokens', 'Exact counts remain available on hover');
  await page.screenshot({ path: path.join(output, `compact-tokens-${width}.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Hide workspace tools', exact: true }).click();
  await page.evaluate(sessionId => {
    const session = window.__uiSessions.find(item => item.id === sessionId);
    Object.assign(session, { status: 'idle', steerTurnId: undefined, locked: false, updatedAt: new Date(Date.now() + 6000).toISOString() });
    window.__steerState = { ...window.__steerState, sequence: 6, status: 'completed', updatedAt: Date.now() + 6000 };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-idle-fixture', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
    window.__holdNextSend = true; window.__heldSendResult = undefined;
  }, parentId);
  await input.fill('Turn start stays pending'); await send.click();
  await page.waitForFunction(() => window.__heldSendResult);
  await page.evaluate(sessionId => {
    const session = window.__uiSessions.find(item => item.id === sessionId);
    Object.assign(session, { status: 'running', steerTurnId: 'pending-send-turn', locked: true, updatedAt: new Date(Date.now() + 7000).toISOString() });
    window.__steerState = { ...window.__steerState, streamId: 'pending-send-fixture', sequence: 0, status: 'running', turnId: 'pending-send-turn', updatedAt: Date.now() + 7000, messages: [...window.__steerState.messages, { id: 'pending-start-echo', role: 'user', kind: 'message', turnId: 'pending-send-turn', text: 'Turn start stays pending' }] };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-active-fixture', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
  }, parentId);
  await page.locator('.cli-queued-message').filter({ hasText: 'Turn start stays pending' }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Message settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Follow-up mode', exact: true }).selectOption('queue');
  await page.keyboard.press('Escape');
  const beforeExplicit = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'steerCodexCliSessionTurn').length);
  await input.fill('Explicit steer from queue mode'); await send.click();
  const queued = page.locator('.cli-queued-message').filter({ hasText: 'Explicit steer from queue mode' });
  await queued.getByRole('button', { name: /Steer$/ }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'steerCodexCliSessionTurn').length), beforeExplicit, 'Queue mode waits until explicitly steered');
  await page.evaluate(() => { window.__holdNextSteer = true; window.__heldSteerResult = undefined; });
  await queued.getByRole('button', { name: /Steer$/ }).click();
  await queued.locator('.cli-live-spinner').waitFor();
  assert.equal(await queued.locator('.cli-live-spinner').count(), 1, 'Steer displays exactly one processing spinner');
  assert.equal(await queued.getByRole('button', { name: 'Edit queued message', exact: true }).count(), 0, 'Processing hides Edit immediately');
  await page.waitForFunction(() => window.__heldSteerResult);
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'steerCodexCliSessionTurn').length), beforeExplicit + 1, 'Explicit Steer sends during a running turn without changing follow-up mode');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldSteerResult })));
  await queued.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Message settings', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Follow-up mode', exact: true }).inputValue(), 'queue', 'Explicit Steer preserves the chosen queue mode');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldSendResult })));

}
