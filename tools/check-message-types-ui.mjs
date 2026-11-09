import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkMessageTypesUi(page, { parentId, agentId, width, output }) {
  const account = page.locator('.cli-turn-usage-strip button.cli-turn-account');
  await account.click();
  const center = page.getByRole('dialog', {name:'Account center',exact:true});
  await center.waitFor();
  const centerBounds = await center.boundingBox();
  assert.ok(Math.abs(centerBounds.x + centerBounds.width / 2 - width / 2) < 2, 'Account center opens in the middle');
  await page.getByRole('button', {name:'Close account menu',exact:true}).click();
  await center.waitFor({state:'hidden'});
  await page.evaluate(() => {
    for(const notice of [{level:'warning',message:'Session history is available, but running state could not be verified. Refresh before sending. Checking saved running activity. Refresh before sending.'},{level:'info',message:'Checking sessions',actions:['Review']}]) dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:notice',...notice}}));
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.dashboard-notice-stack').count(),0,'Workspace never shows information or routine inspection toasts');
  const composer = page.locator('.cli-composer');
  const stableBounds = await composer.boundingBox();
  await page.evaluate(() => { dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})); dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:host-status',stage:'offline'}})); });
  await page.locator('.dashboard-connection-banner').waitFor();
  assert.equal(await page.locator('fieldset.cli-workspace').evaluate(element => element.disabled && element.inert),true,'Offline workspace actions are disabled');
  assert.equal(await page.locator('.cli-composer-state').count(),0,'No status row below the composer');
  assert.deepEqual(await composer.boundingBox(),stableBounds,'Offline feedback never shifts the composer');
  const banner = await page.locator('.dashboard-connection-banner').boundingBox();
  assert.ok(banner.x < 25 && banner.y > 100,'Offline banner is at bottom left');
  await page.evaluate(() => { dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})); dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:host-status',stage:'live'}})); });
  await page.locator('.dashboard-connection-banner').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Session actions',exact:true}).click();
  await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
  await page.getByRole('button',{name:'Restore session',exact:true}).waitFor();
  await page.waitForFunction(() => !!window.__heldArchiveResult);
  await page.evaluate(() => dispatchEvent(new MessageEvent('message',{data:{...window.__heldArchiveResult,status:'failed',payload:undefined,error:'Archive not confirmed; conversation restored.'}})));
  await page.locator('.dashboard-notice-stack').filter({hasText:'Archive not confirmed'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Restore session',exact:true}).count(),0,'Failed optimistic archive restores the session');
  await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
  const raw = JSON.stringify({ command: 'x'.repeat(1200), nested: { exact: '90071992547409931234', list: [1, 2] } });
  const fixtures = [
    { id: 'user-types', kind: 'message', role: 'user', text: 'Check every presentation.' },
    { id: 'reason-types', kind: 'reasoning', text: 'Considering the next step.', status: 'completed' },
    { id: 'plan-types', kind: 'plan', text: '1. Inspect messages\n2. Improve presentation', status: 'completed' },
    { id: 'tool-types', kind: 'tool-call', title: 'Used formatting tool', text: 'Formatted output', arguments: raw, result: '\n\nshort result\n\n', debug: raw, status: 'completed' },
    { id: 'command-types', kind: 'command', text: 'echo output', command: 'echo output', output: 'long-token-'.repeat(150), status: 'completed' },
    { id: 'files-types', kind: 'file-change', text: 'Edited files', changes: [{ path: 'src/example.ts', kind: 'update', diff: '@@ -1 +1 @@\n-before\n+after' }], status: 'completed' },
    { id: 'search-types', kind: 'web-search', text: 'Documentation query', result: '[Documentation](https://example.com/docs)', status: 'completed' },
    { id: 'image-types', kind: 'image', text: 'Viewed reference image', images: [{src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwZQAAAAASUVORK5CYII=',alt:'Reference image'}], status:'completed' },
    { id: 'review-types', kind: 'review', text: '**Review complete.** No regressions found.', status: 'completed' },
    { id: 'compact-types', kind: 'compaction', text: 'Earlier context was condensed.', status: 'completed' },
    { id: 'capacity-types', kind: 'tool-call', text: 'Selected model is at capacity.', result: '{"error":"model_overloaded"}', debug: '{"error":"model_overloaded"}', status: 'failed' },
    { id: 'error-types', kind: 'error', text: 'Request failed. Reconnect before retrying.', debug: raw, status: 'failed' },
    { id: 'agent-types', kind: 'collaboration', title: 'Reviewer finished', text: 'Checked the changes.', debug: JSON.stringify({ receiverThreadIds: [agentId], agentsStates: { [agentId]: 'completed' } }), result: '{"status":"completed"}', status: 'completed' },
    { id: 'agent-message-types', kind: 'tool-call', title: 'Used send_input', text: 'Sent review notes.', arguments: JSON.stringify({ id: agentId, message: 'Check the changes.' }), status: 'completed' },
    { id: 'agent-wait-types', kind: 'collaboration', title: 'Waited for agents', text: 'Waiting finished.', debug: JSON.stringify({ receiverThreadIds: [agentId, parentId] }), status: 'completed' },
    { id: 'agent-missing-types', kind: 'collaboration', title: 'Missing agent', text: 'An older agent contributed.', debug: JSON.stringify({ receiverThreadIds: ['99999999-9999-4999-8999-999999999999'] }), status: 'completed' }
  ];
  await page.evaluate(({ messages, sessionId }) => {
    window.__questionHistory = messages;
    dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: { sessionId, streamId: '66666666-6666-4666-8666-666666666666', sequence: 1, status: 'completed', updatedAt: Date.now(), messages } } }));
  }, { messages: fixtures, sessionId: parentId });
  await page.locator('.cli-capacity-notice').waitFor();
  await page.waitForFunction(() => { const tools = document.querySelectorAll('.cli-session-messages .cli-activity.is-tool-call'); return tools.length === 2 && tools[0].textContent.includes('Formatted output'); });
  const capacity = page.locator('.cli-capacity-notice');
  assert.equal((await capacity.innerText()).trim(), 'Model at capacity', 'Capacity uses one short status line');
  assert.ok(await capacity.evaluate(element => element.getBoundingClientRect().height <= Math.max(32, parseFloat(getComputedStyle(element).lineHeight) + 8)), 'Capacity does not reserve a multi-line block');
  assert.equal(await capacity.locator('pre').isVisible(), false, 'Capacity diagnostics start collapsed');
  await capacity.locator('summary').click();
  assert.deepEqual(JSON.parse(await capacity.locator('pre').innerText()), { error: 'model_overloaded' }, 'Original diagnostics stay available');
  await capacity.locator('summary').click();
  assert.equal((await capacity.innerText()).trim(), 'Model at capacity');
  await page.evaluate(({ messages, sessionId }) => dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: { sessionId, streamId: '77777777-7777-4777-8777-777777777777', sequence: 2, status: 'running', updatedAt: Date.now(), messages: [...messages, { id: 'native-retry', kind: 'error', text: 'Reconnecting... 2/5', status: 'inProgress' }] } } })), { messages: fixtures, sessionId: parentId });
  const retry = page.getByRole('status').filter({ hasText: /^Reconnecting 2\/5$/ });
  await retry.waitFor();
  assert.ok(await retry.evaluate(element => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 2), 'Native retry stays on one line');
  await page.evaluate(({ messages, sessionId }) => dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: { sessionId, streamId: '77777777-7777-4777-8777-777777777777', sequence: 3, status: 'completed', updatedAt: Date.now(), messages } } })), { messages: fixtures, sessionId: parentId });
  await retry.waitFor({ state: 'hidden' });
  const completedAgents=page.locator('.cli-activity-group-body > .cli-activity.is-collaboration');
  assert.equal(await completedAgents.count(),3,'Completed agent events join the shared completed-activity group');
  assert.equal(await completedAgents.first().evaluate(element=>element.closest('.cli-activity-group-details').open),false,'Completed agent work starts collapsed with the other tools');
  assert.equal(await page.locator('.cli-activity-group').filter({has:page.locator('.cli-activity.is-collaboration')}).count(),1,'Adjacent agent and send-input activity share one disclosure');
  for (const group of await page.locator('.cli-activity-group-details').all()) if (!await group.evaluate(element => element.open)) await group.locator(':scope > summary').click();
  for (const kind of ['plan', 'command', 'tool-call', 'web-search', 'review', 'compaction', 'error', 'collaboration']) {
    const row = page.locator(`.cli-session-messages > .cli-activity.is-${kind}, .cli-activity-group-body > .cli-activity.is-${kind}`).first();
    if (!await row.evaluate(element => element.open)) { if (kind === 'collaboration') await row.locator('.cli-agent-detail-toggle').click(); else await row.locator(':scope > summary').click(); }
  }
  const tool = page.locator('.cli-activity.is-tool-call').first();
  const args = tool.locator('pre[aria-label="Arguments"]');
  await args.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('pre[aria-label="Arguments"]')?.innerText.includes('"command"'));
  assert.match(await args.innerText(), /\n  "command":/);
  assert.equal(await args.evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
  assert.ok(await args.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long tokens fit the panel');
  const result = tool.locator('pre[aria-label="Result"]');
  await result.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('pre[aria-label="Result"]')?.innerText === 'short result');
  assert.equal(await result.innerText(), 'short result');
  assert.ok((await result.boundingBox()).height < 100, 'Short results have no blank padding');
  assert.equal(await tool.locator('.cli-debug-details').evaluate(element => element.open), false);
  await tool.getByRole('button', { name: 'Copy code', exact: true }).click();
  await tool.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => undefined));
  if (copied !== undefined) assert.equal(copied, raw);
  assert.equal(await page.locator('.cli-activity.is-plan ol').count(), 1);
  assert.equal(await page.locator('.cli-activity.is-web-search a[href="https://example.com/docs"]').count(), 1);
  assert.equal(await page.locator('.cli-diff-line.is-added').count(), 1);
  const image = page.locator('.cli-activity.is-image'); if (!await image.evaluate(element => element.open)) await image.locator(':scope > summary').click();
  await image.getByRole('button', {name:'Preview Reference image',exact:true}).click();
  await page.getByRole('button',{name:'Close image preview',exact:true}).click();
  assert.equal(await page.locator('.cli-agent-links').count(), 0, 'Agent activities have no separate open button');
  await page.locator('.cli-activity.is-collaboration').filter({ hasText: 'Completed Reviewer' }).locator(':scope > summary .cli-activity-heading').click();
  await page.getByText('Agent reviewer message', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close workspace tools', exact: true }).last().click();
  await page.locator('.cli-activity.is-tool-call').filter({ hasText: 'Sent message to Reviewer' }).locator(':scope > summary .cli-activity-heading').click();
  await page.getByText('Agent reviewer message', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close workspace tools', exact: true }).last().click();
  await page.locator('.cli-activity.is-collaboration').filter({ hasText: 'Waited for agents' }).locator(':scope > summary .cli-activity-heading').click();
  await page.locator('.cli-agent-roster').waitFor();
  await page.locator('.cli-agent-roster .cli-agent-row').filter({ hasText: 'Reviewer' }).click();
  await page.getByText('Agent reviewer message', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close workspace tools', exact: true }).last().click();
  const missing = page.locator('.cli-activity.is-collaboration').filter({ hasText: 'Missing agent' });
  await missing.locator(':scope > summary').press('Enter');
  await page.getByText('This agent is not in the saved session list. Refresh sessions and try again.', { exact: true }).first().waitFor();
  const article = page.locator('.cli-session-message').first();
  await article.focus();
  assert.equal(await article.evaluate(element => getComputedStyle(element).outlineStyle),'none','Message cards have no blue focus border');
  const input = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.fill('/');
  const choices = page.getByRole('listbox', { name: 'Commands and skills' });
  await choices.getByRole('option').filter({ hasText: '$review-code' }).waitFor();
  const before = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'sendCodexCliSessionMessage').length);
  await input.fill('/review'); await input.press('Enter');
  assert.equal(await input.inputValue(), '$review-code ');
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'sendCodexCliSessionMessage').length), before, 'Selecting a skill never sends a message');
  await input.fill('/'); await input.press('Escape'); await choices.waitFor({ state: 'hidden' });
  await input.fill('/model'); await input.press('Enter');
  await page.getByRole('group', { name: 'Message settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close message settings', exact: true }).click();
  await page.evaluate(() => { window.__failSkills = true; });
  await input.fill('/skills'); await choices.getByRole('status').filter({ hasText: 'Skill discovery is offline. Retry when connected.' }).waitFor();
  await page.evaluate(() => { window.__failSkills = false; });
  await choices.getByRole('button', { name: 'Retry skills', exact: true }).click();
  await choices.getByRole('option').filter({ hasText: '$review-code' }).click();
  assert.equal(await input.inputValue(), '$review-code ');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
  await page.screenshot({ path: path.join(output, `message-types-${width}.png`) });
  await page.goto(new URL('/', page.url()).href);
  await page.locator('.dashboard-action-scope').waitFor();
  await page.evaluate(() => { dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})); dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:host-status',stage:'offline'}})); });
  const recovery = page.locator('.dashboard-offline-overlay');
  await recovery.waitFor();
  assert.equal(await page.locator('.dashboard-action-scope').evaluate(element => element.disabled && element.inert),true,'Dashboard actions are disabled offline');
  assert.equal(await recovery.getByRole('button',{name:'Try connecting again'}).isEnabled(),true);
  const card = await recovery.locator('.dashboard-connection-recovery').boundingBox();
  assert.ok(Math.abs(card.x + card.width / 2 - width / 2) < 2,'Dashboard offline panel is centered over the masked view');
  assert.equal(await page.locator('.dashboard-connection-banner').count(),0,'Dashboard uses only its central offline panel');
  await page.screenshot({path:path.join(output,`dashboard-offline-${width}.png`)});
  await page.evaluate(() => { dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})); dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:host-status',stage:'live'}})); });
  await recovery.waitFor({state:'hidden'});
}
