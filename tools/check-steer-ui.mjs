import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkInlineQueueUi(page, { origin, parentId, output, width }) {
  const started = performance.now();
  if (process.argv.includes('--queue-storage-fallback')) await page.addInitScript(sessionId => {
    const scope = JSON.stringify(['fixture-local', 'session', sessionId]);
    const key = `codex-manager-cache:recovery:browser:message-queue:${scope}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ updatedAt: Date.now(), value: [] }));
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('Storage unavailable', 'UnknownError'); } } });
  }, parentId);
  await page.goto(`${origin}/workspace/${parentId}`);
  const input = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.waitFor();
  await page.evaluate(sessionId => {
    Object.assign(window.__uiSessions.find(item => item.id === sessionId), { status: 'running', steerTurnId: 'inline-queue-turn' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-inline-queue', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
  }, parentId);
  await page.getByRole('button', { name: 'Message settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Follow-up mode', exact: true }).selectOption('queue');
  await page.keyboard.press('Escape');
  for (const text of ['First queued message', 'Second queued message']) {
    await input.fill(text);
    await page.locator('.cli-send-button').click();
  }
  const rows = page.locator('.cli-local-queue > .cli-queued-message');
  const first = rows.filter({ hasText: 'First queued message' }), second = rows.filter({ hasText: 'Second queued message' });
  await second.getByRole('button', { name: /Steer$/ }).waitFor();
  assert.equal(await rows.count(), 2, 'Every waiting message has an inline row');
  assert.equal(await first.isVisible(), true);
  assert.equal(await first.evaluate(row => row.open), false, 'Queue rows start collapsed');
  const queueHeight = await first.locator('summary').evaluate(row => row.getBoundingClientRect().height);
  assert.ok(width <= 760 ? queueHeight >= 32 && queueHeight <= 36 : queueHeight >= 42, 'Mobile queues stay compact and desktop controls retain their spacing');
  const steerHeight = await first.getByRole('button', { name: /Steer$/ }).evaluate(button => button.getBoundingClientRect().height);
  assert.ok(width > 760 || steerHeight <= 26, 'Mobile Steer stays compact');
  assert.equal(await page.locator('.cli-local-queue-status').count(), 0, 'Routine queue status has no message row');
  await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); window.dispatchEvent(new Event('blur')); });
  assert.equal(await first.isVisible(), true, 'Moving focus never hides a pending queue');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await first.isVisible(), true, 'Background visibility changes retain queued messages');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.locator('.cli-local-queue-summary, .cli-queue-modal').count(), 0, 'No summary or modal hides queued messages');
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item => item.action === 'steerCodexCliSessionTurn').length), 0, 'Queue mode waits for explicit steering');
  assert.ok(await first.evaluate(row => row.getBoundingClientRect().bottom <= document.querySelector('.cli-composer').getBoundingClientRect().top), 'Queue rows sit above the composer');
  await first.locator(':scope > summary').click();
  assert.equal(await first.evaluate(row => row.open), true, 'Full text expands inline');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Queue rows fit the viewport');
  await page.screenshot({ path: path.join(output, `queue-inline-${width}.png`), animations: 'disabled' });
  await first.locator(':scope > summary').click();
  await second.getByRole('button', { name: 'Edit queued message', exact: true }).click();
  await second.waitFor({ state: 'hidden' });
  assert.equal(await input.inputValue(), 'Second queued message', 'Edit restores the draft');
  await page.locator('.cli-send-button').click();
  await second.getByRole('button', { name: 'Delete queued message', exact: true }).click();
  await second.waitFor({ state: 'hidden' });
  await input.fill('Keep my newer draft');
  await page.evaluate(() => { window.__holdNextSteer = true; window.__heldSteerResult = undefined; });
  await first.getByRole('button', { name: /Steer$/ }).click();
  await page.waitForFunction(() => window.__heldSteerResult);
  assert.equal(await first.isVisible(), true, 'A sending queue remains visible until delivery is confirmed');
  await first.locator('.cli-live-spinner').waitFor();
  await page.locator('.cli-session-message.is-user').filter({ hasText: 'First queued message' }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldSteerResult, status: 'failed', error: 'Steering could not be confirmed. Check before retrying.' } })));
  await first.getByRole('alert').waitFor();
  assert.equal(await page.locator('.dashboard-notice').filter({ hasText: 'Steering could not be confirmed.' }).count(), 0, 'Queue delivery feedback stays in its status tools without a toast');
  assert.equal(await first.evaluate(row => row.open), false, 'Failure does not expand a row without user action');
  assert.equal(await first.getByRole('alert').getAttribute('title'), 'Steering could not be confirmed. Check before retrying.', 'The error is available on the warning icon');
  await first.getByRole('button', { name: 'Resend queued message', exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'Keep my newer draft', 'Steering and failure preserve newer input');
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item => item.action === 'steerCodexCliSessionTurn').length), 1, 'Explicit steering dispatches once');
  await page.screenshot({ path: path.join(output, `queue-inline-failure-${width}.png`), animations: 'disabled' });
  const sidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menu', { name: 'Account menu', exact: true }).getByRole('menuitem', { name: 'Tools', exact: true }).click();
  await page.getByRole('dialog', { name: 'Tools', exact: true }).getByRole('button', { name: /Queue status/ }).click();
  const tools = page.getByRole('dialog', { name: 'Queue status', exact: true });
  await tools.getByText('1 queue · 1 message', { exact: true }).waitFor();
  await tools.getByRole('button', { name: 'Fix queues', exact: true }).click();
  await tools.getByText(/Checked 1 queue/).waitFor();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item => item.action === 'steerCodexCliSessionTurn').length), 1, 'Fix never replays an ambiguous delivery');
  await tools.locator('details > summary').click();
  await tools.getByText('Steering could not be confirmed. Check before retrying.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `queue-tools-${width}.png`), animations: 'disabled' });
  await tools.getByRole('button', { name: 'Clear all', exact: true }).click();
  await tools.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await rows.count(), 1, 'Cancelling Clear all preserves queued messages');
  await tools.getByRole('button', { name: 'Clear all', exact: true }).click();
  await tools.getByRole('button', { name: 'Confirm clear all', exact: true }).click();
  await tools.getByText('0 queues · 0 messages', { exact: true }).waitFor();
  await tools.getByRole('button', { name: 'Close tools', exact: true }).click();
  assert.equal(await rows.count(), 0, 'Clear all updates the initiating queue immediately');
  assert.equal(await input.inputValue(), 'Keep my newer draft', 'Tools preserve the current composer draft');
  console.log(`${width}px inline queue controls verified in ${Math.round(performance.now() - started)}ms`);
}

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
  const { height: queueHeight, padding: queuePadding, gap: queueGap, ...queueStyle } = matchingRows.queue;
  const { height: goalHeight, padding: goalPadding, gap: goalGap, ...goalStyle } = matchingRows.goal;
  assert.deepEqual(queueStyle, goalStyle, 'Queue rows align with the goal row and retain its visual styles');
  assert.ok(width <= 760 ? queueHeight >= 32 && queueHeight <= 36 : queueHeight >= 42 && queueHeight >= goalHeight, 'Queue actions use the expected mobile and desktop height');
  const iconSizes = await page.evaluate(() => {
    const size = selector => { const style = getComputedStyle(document.querySelector(selector)); return { width: style.width, height: style.height }; };
    return { goal: size('.cli-goal-strip:not(.cli-queued-message) .cli-goal-mark svg'), spinner: size('.cli-queued-message .cli-live-spinner') };
  });
  assert.ok(parseFloat(iconSizes.spinner.width) >= 10 && parseFloat(iconSizes.spinner.width) <= parseFloat(iconSizes.goal.width), 'The single sending spinner remains visible inside the queue mark');
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
  assert.ok(width <= 760 ? controlSizes.queue.width === 24 && controlSizes.queue.height === 24 : controlSizes.queue.width >= controlSizes.goal.width && controlSizes.queue.height >= controlSizes.goal.height, 'Queue controls use compact mobile sizing');
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
  await page.locator('.cli-local-queue .is-sending').waitFor({ state: 'hidden' });
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
    await page.waitForFunction(status => document.querySelector('.cli-composer .cli-send-button')?.getAttribute('aria-label') === (status === 'unknown' ? 'Send message' : 'Send follow-up'), status);
    assert.equal(await page.evaluate(() => window.__composerNode === document.querySelector('textarea[name="codex-message"]')), true, 'Status refresh never unmounts the composer');
    assert.equal(await input.inputValue(), 'Native owner guidance', 'Status refresh preserves typed guidance');
    await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
    if(status==='unknown') assert.equal(await send.isEnabled(),true,'Unverified sessions accept a local queued draft without dispatching');
  }
  for (const connected of [false,true]) {
    await page.evaluate(connected => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:host-status', stage: connected ? 'live' : 'unreachable' } }));
    }, connected);
    await page.waitForFunction(connected => document.querySelector('.cli-composer .cli-send-button')?.getAttribute('aria-label') === (connected ? 'Send follow-up' : 'Send message'), connected);
    assert.equal(await page.evaluate(() => window.__composerNode === document.querySelector('textarea[name="codex-message"]')), true, 'Reconnect preserves the composer node');
    assert.equal(await input.inputValue(), 'Native owner guidance');
    await page.getByRole('button',{name:'Remove guidance.txt',exact:true}).waitFor();
    if(!connected){
      assert.equal(await input.isDisabled(),false,'Offline drafts remain editable');
      const before=await page.evaluate(()=>window.__uiActions.filter(item=>['sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(item.action)).length);
      await input.fill('Native owner guidance edited offline');
      await input.fill('Native owner guidance');
      assert.equal(await page.locator('.cli-local-queue').getByRole('button',{name:'Resend queued message',exact:true}).count(),0,'Offline queued messages do not offer Resend');
      assert.equal(await input.getAttribute('placeholder'),'Message Codex…','Connection status keeps the default composer placeholder');
      assert.equal(await page.evaluate(()=>window.__uiActions.filter(item=>['sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(item.action)).length),before,'Offline draft edits never dispatch');
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
    window.__steerState = { ...window.__steerState, streamId: 'native-owner-fixture', turnId: 'native-follow-up', sequence: 5, status: 'running', updatedAt: Date.now() + 5000, tokenUsage: { input: 276906687, cachedInput: 272657408, output: 251524, reasoningOutput: 96616, total: 277158211, contextWindow: 475000 } };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
  });
  const showTools = page.getByRole('button', { name: 'Show workspace tools', exact: true });
  if (await showTools.isVisible()) await showTools.click();
  await page.getByRole('tab', { name: 'Env', exact: true }).click();
  await page.getByLabel('Session usage details', { exact: true }).locator('summary').click();
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
