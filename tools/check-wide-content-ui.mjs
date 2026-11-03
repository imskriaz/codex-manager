import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkWideContentUi(page, { origin, parentId, width, output }) {
  await page.goto(origin + '/workspace/' + parentId);
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
  await page.evaluate(sessionId => {
    const text = '| Component | Current state | Next action | Owner | Reference | Updated |\n| --- | --- | --- | --- | --- | --- |\n| Shared session renderer | Ready for review | Verify readable columns | Mobile dashboard team | ' + 'long_reference_'.repeat(12) + ' | Today |';
    window.__uiMessages.push({ id: 'wide-table', role: 'assistant', kind: 'message', text });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: { sessionId, streamId: 'wide-content', sequence: 1, turnId: 'wide-turn', status: 'running', updatedAt: Date.now() + 1000, messages: window.__uiMessages } } }));
  }, parentId);
  const region = page.getByRole('region', { name: 'Scrollable table', exact: true }).last();
  await region.waitFor();
  await region.scrollIntoViewIfNeeded();
  assert.equal(await region.getAttribute('tabindex'), '0', 'Wide tables support keyboard scrolling');
  const geometry = await region.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, cell: element.querySelector('th').getBoundingClientRect().width }));
  assert.ok(geometry.cell >= 80, 'Columns retain readable width');
  if (width <= 760) {
    assert.ok(geometry.content > geometry.width + 1, 'Wide tables scroll locally on mobile');
    await region.focus();
    await page.keyboard.press('End');
    await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    assert.ok(await region.evaluate(element => element.scrollLeft > 0), 'Offscreen columns can be reached');
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Wide content never widens the page');
  await page.screenshot({ path: path.join(output, 'wide-table-' + width + '.png'), animations: 'disabled' });
}
