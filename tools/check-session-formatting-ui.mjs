import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkSessionFormattingUi(page, { origin, parentId, width, output, transcriptOnly = false }) {
  const started = performance.now();
  await page.goto(origin + '/workspace/' + parentId);
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
  const source = '*** Begin Patch\n*** Update File: D:\\projects\\new\\test.ts\n@@\n+const value = "text";\n*** End Patch';
  const args = `const patch = ${JSON.stringify(source)};`;
  const result = '[Documentation](https://example.com/docs)\n\n' + Array.from({ length: 70 }, (_, index) => `L${index}: A readable documentation line.`).join('\n');
  const messages = [
    { id: 'format-user', role: 'user', kind: 'message', text: 'Inspect formatting.' },
    { id: 'format-tool', kind: 'tool-call', title: 'Used exec', text: 'Script completed', arguments: args, result: 'Done', status: 'completed' },
    { id: 'format-search', kind: 'web-search', text: 'Documentation query', result, status: 'completed' },
    ...['update', 'add', 'delete', 'rename'].map((kind, index) => ({ id: `format-file-${index}`, kind: 'file-change', text: 'Changed files', status: 'completed', changes: [{ path: `src/example${index}.ts`, kind, diff: '@@ -1 +1 @@\n-before\n+after' }] }))
  ];
  await page.evaluate(({ messages, sessionId }) => {
    window.__questionHistory = messages;
    window.__uiMessages.splice(0, window.__uiMessages.length, ...messages);
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__formatCopied = text; } });
    dispatchEvent(new MessageEvent('message', { data: {
    type: 'dashboard:codex-session-live', state: { sessionId, streamId: '77777777-7777-4777-8777-777777777777', sequence: 1, status: 'completed', updatedAt: Date.now(), messages }
    } }));
  }, { messages, sessionId: parentId });
  const group = page.locator('.cli-activity-group-details').filter({ hasText: 'Used exec' });
  await group.waitFor({ state: 'attached' });
  if (!await group.evaluate(element => element.open)) await group.locator(':scope > summary').click();
  for (const kind of ['tool-call', 'web-search']) {
    const activity = group.locator(`.cli-activity.is-${kind}`);
    if (!await activity.evaluate(element => element.open)) await activity.locator(':scope > summary').click();
  }
  const tool = group.locator('.cli-activity.is-tool-call');
  assert.equal(await tool.locator('pre[aria-label="Arguments"]').innerText(), `const patch = "${source}";`);
  await tool.getByRole('button', { name: 'Copy code', exact: true }).click();
  await tool.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__formatCopied), args);
  assert.equal(await page.getByRole('button', { name: 'Open all in Reviews', exact: true }).count(), 0);
  assert.equal(await group.getByRole('button', { name: 'Review', exact: true }).count(), 4);
  const fileLabels = group.locator('.cli-file-change-list > details > summary strong');
  assert.deepEqual(await fileLabels.allTextContents(), ['Edited src/example0.ts', 'Created src/example1.ts', 'Deleted src/example2.ts', 'Rename src/example3.ts']);
  const activityWeight = await tool.locator('.cli-activity-heading strong').evaluate(element => getComputedStyle(element).fontWeight);
  assert.ok(await fileLabels.evaluateAll((elements, weight) => elements.every(element => getComputedStyle(element).fontWeight === weight), activityWeight), 'File labels match the bold tool activity headings');
  const file = group.locator('.cli-file-change-list > details').first();
  await file.locator(':scope > summary').click();
  assert.ok(await file.locator('.cli-diff-surface').isVisible(), 'Labeled file rows still expand their diffs');
  await file.locator(':scope > summary').click();
  await file.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `session-file-labels-${width}.png`) });
  const search = group.locator('.cli-activity.is-web-search');
  const region = search.getByRole('region', { name: 'Search results', exact: true });
  assert.ok(await region.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight <= 360), 'Long search results scroll inside a bounded panel');
  assert.equal(await search.getByRole('link', { name: 'Documentation', exact: true }).getAttribute('href'), 'https://example.com/docs');
  await search.getByRole('button', { name: 'Copy search results', exact: true }).click();
  await search.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__formatCopied), result);
  assert.ok(await group.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Transcript panels fit the viewport');
  await search.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `session-formatting-${width}.png`) });
  if (transcriptOnly) {
    console.log(JSON.stringify({ width, durationMs: Math.round(performance.now() - started), checks: 'Bold file action labels, expandable diffs, exact copies, bounded search results and transcript overflow' }));
    return;
  }

  await page.goto(origin + '/');
  await page.locator('#settingsOpenButton').click();
  const modal = page.locator('.settings-modal:visible');
  await modal.locator('#settings-tab-general').click();
  const zoom = modal.locator('[data-setting="webview-zoom"]');
  await zoom.waitFor();
  assert.ok((await zoom.boundingBox()).height <= 115, 'Zoom uses a compact settings row');
  const notifications = modal.locator('.browser-notification-settings');
  assert.ok((await notifications.boundingBox()).height <= (width > 650 ? 100 : 145), 'Browser notification controls stay compact');
  for (const label of await modal.locator('.settings-tab-label').all()) assert.ok(await label.isVisible(), 'Every tab keeps its label visible');
  assert.equal(await modal.locator('.settings-tab-description').count(), 0, 'Tabs have no truncated descriptions');
  await modal.locator('#settings-tab-general').press('ArrowRight');
  assert.equal(await modal.locator('#settings-tab-automation').getAttribute('aria-selected'), 'true');
  await modal.locator('#settings-tab-automation').press('Home');
  assert.equal(await modal.locator('#settings-tab-general').getAttribute('aria-selected'), 'true');
  const range = zoom.getByRole('slider');
  await range.focus();
  await range.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[data-setting="webview-zoom"] input').value === '110');
  await zoom.getByRole('button', { name: 'Reset zoom', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-setting="webview-zoom"] input').value === '100');
  await page.screenshot({ path: path.join(output, `settings-zoom-general-${width}.png`) });
  for (const tab of ['automation', 'data', 'tools']) {
    await modal.locator(`#settings-tab-${tab}`).click();
    assert.equal(await zoom.count(), 0, `Zoom is absent from ${tab}`);
  }
  await modal.locator('#settings-tab-automation').click();
  await page.screenshot({ path: path.join(output, `settings-zoom-automation-${width}.png`) });
  await modal.locator('#settings-tab-general').click();
  await page.evaluate(() => { dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })); });
  assert.equal(await zoom.getByRole('slider').isEnabled(), true, 'Device zoom stays available offline');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Settings fit the viewport');
  console.log(JSON.stringify({ width, durationMs: Math.round(performance.now() - started), checks: 'Readable arguments, exact original copies, bounded search results, file Review controls, General-only compact zoom and offline zoom' }));
}
