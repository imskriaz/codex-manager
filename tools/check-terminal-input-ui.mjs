import assert from 'node:assert/strict';
import path from 'node:path';

// Runs inside the responsive harness; keystrokes only reach its in-memory shell.
export async function checkTerminalInputUi(page, { origin, parentId, width, output }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
  const show = page.getByRole('button', { name: 'Show workspace tools', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('button', { name: 'Add workspace tool', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'New shared terminal', exact: true }).click();
  const input = page.locator('.workspace-xterm textarea');
  await input.waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('.workspace-xterm textarea')?.readOnly === false);
  assert.equal(await input.evaluate(element => element === document.activeElement), true, 'Opening a terminal focuses its keyboard input');

  const received = () => page.evaluate(() => window.__uiActions.filter(action => action.action === 'workspaceTerminal' && action.payload?.terminalRequest?.operation === 'input').map(action => action.payload.terminalRequest.data).join(''));
  let expected = '';
  for (const [key, data] of [
    ['a', 'a'], ['ArrowDown', '\x1b[B'], ['ArrowUp', '\x1b[A'], ['Enter', '\r'],
    ['Escape', '\x1b'], ['Tab', '\t'], ['Backspace', '\x7f'],
    ['Control+c', '\x03'], ['Control+f', '\x06'], ['Control+l', '\x0c']
  ]) {
    await page.keyboard.press(key);
    expected += data;
    await page.waitForFunction(expected => window.__uiActions.filter(action => action.action === 'workspaceTerminal' && action.payload?.terminalRequest?.operation === 'input').map(action => action.payload.terminalRequest.data).join('') === expected, expected);
    assert.ok(await page.locator('.workspace-xterm').isVisible(), `${key} keeps the terminal open`);
  }
  assert.equal(await received(), expected, 'Each key reaches the terminal exactly once');
  assert.equal(await page.getByRole('textbox', { name: 'Message Codex', exact: true }).inputValue(), '', 'Terminal typing never reaches the composer');

  await page.keyboard.press('Control+Shift+f');
  const find = page.getByRole('textbox', { name: 'Find terminal text', exact: true });
  await find.waitFor();
  await find.fill('Fixture');
  await page.keyboard.press('Escape');
  await find.waitFor({ state: 'detached' });
  assert.equal(await input.evaluate(element => element === document.activeElement), true, 'Closing search restores terminal focus');
  assert.equal(await received(), expected, 'Search stays out of shell input');

  await input.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'paste বাংলা');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  expected += 'paste বাংলা';
  await page.waitForFunction(expected => window.__uiActions.filter(action => action.action === 'workspaceTerminal' && action.payload?.terminalRequest?.operation === 'input').map(action => action.payload.terminalRequest.data).join('') === expected, expected);

  await page.getByRole('button', { name: 'Refresh terminals', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-xterm textarea')?.readOnly === false);
  assert.equal(await received(), expected, 'Restoring a screen never replays input');
  // Clicking the terminal padding must also focus the actual input.
  await page.locator('.workspace-xterm').click({ position: { x: 12, y: 2 } });
  assert.equal(await input.evaluate(element => element === document.activeElement), true, 'Clicking the terminal surface focuses input');

  await page.screenshot({ path: path.join(output, `terminal-input-${width}.png`), animations: 'disabled' });
  await page.evaluate(() => { window.__loseTerminalInput = true; });
  await page.keyboard.press('x');
  const failure = page.locator('.workspace-terminal-status').filter({ hasText: 'did not confirm this action' });
  await failure.waitFor({ timeout: 15_000 });
  assert.equal(await input.evaluate(element => element.readOnly), true, 'Unconfirmed input visibly locks the terminal');
  const failedInput = await received();
  await page.keyboard.press('y');
  assert.equal(await received(), failedInput, 'Input after a missing acknowledgement is not sent');
  await page.evaluate(() => { window.__loseTerminalInput = false; });
  await page.getByRole('button', { name: 'Refresh terminals', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.workspace-xterm textarea')?.readOnly === false);
  assert.equal(await received(), failedInput, 'Recovery never replays unconfirmed or rejected keystrokes');
}
