import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkToolFailureUi(page, { width, output }) {
  const id = '12345678-1234-1234-1234-123456789abc';
  const error = 'This binary file cannot be read as text with the available file reader. Use a compatible reader or a supported text export.';
  const explanation = 'Read file (archive.pst) could not be completed: ' + error;
  const messages = [
    { id: 'user', role: 'user', text: 'Review the messages in my project.' },
    { id: 'read-archive', kind: 'tool-call', title: 'Read file', text: error, status: 'failed', arguments: JSON.stringify({ path: 'archive.pst' }), result: JSON.stringify({ error, instruction: 'Try another supported approach.' }) },
    { id: 'explanation', role: 'assistant', text: explanation },
    { id: 'alternative', kind: 'tool-call', title: 'Read file', text: 'Read file', status: 'completed', arguments: JSON.stringify({ path: 'export.csv' }), result: JSON.stringify({ status: 'completed', payload: { workspaceFile: { path: 'export.csv', content: 'Subject,From\nOrder,Buyer', kind: 'text' } } }) },
    { id: 'answer', role: 'assistant', text: 'I used the readable CSV export: it contains an order from Buyer.\n\nCould not complete these actions:\n- archive.pst: ' + error }
  ];
  await page.evaluate(({ id, messages }) => localStorage.setItem('private-workspace-fixture', JSON.stringify({ session: { id, title: 'Recover file read', status: 'idle' }, messages })), { id, messages });
  const started = Date.now();
  await page.goto(new URL('/workspace/' + id, page.url()).href);
  await page.getByText(explanation, { exact: true }).waitFor({ state: 'attached' });
  await page.getByText('I used the readable CSV export: it contains an order from Buyer.', { exact: true }).waitFor();
  await page.getByText('Could not complete these actions:', { exact: true }).waitFor();
  assert.ok(await page.getByText('archive.pst: ' + error, { exact: true }).isVisible(), 'The final failure reason stays visible outside collapsed tool details');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Failure text fits the viewport');
  await page.screenshot({ path: path.join(output, `tool-failure-${width}.png`), fullPage: true, animations: 'disabled' });
  console.log(JSON.stringify({ width, elapsedMs: Date.now() - started, visibleFailure: true, alternativeResult: true, finalLimitation: true }));
}
