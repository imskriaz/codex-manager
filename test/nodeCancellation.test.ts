import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { CancellationTokenSource } = require('../tools/node-vscode-shim/vscode.js') as typeof import('vscode');
afterEach(() => vi.useRealTimers());
it('provides a standalone OAuth cancellation source and notifies each registered listener once', () => {
  const source = new CancellationTokenSource(), cancelled = vi.fn();
  const disposables: import('vscode').Disposable[] = [];
  source.token.onCancellationRequested(cancelled, undefined, disposables);
  expect(source.token.isCancellationRequested).toBe(false);
  source.cancel(); source.cancel();
  expect(source.token.isCancellationRequested).toBe(true); expect(cancelled).toHaveBeenCalledOnce();
  expect(disposables).toHaveLength(1); source.dispose();
});
it('supports cleanup after successful OAuth without cancelling a completed flow', () => {
  const source = new CancellationTokenSource(), cancelled = vi.fn();
  source.token.onCancellationRequested(cancelled); source.dispose(); source.cancel();
  expect(cancelled).not.toHaveBeenCalled(); expect(source.token.isCancellationRequested).toBe(false);
});
it('supports cancelled sources, late subscribers, removed listeners, and cancellation during disposal', () => {
  vi.useFakeTimers();
  const source = new CancellationTokenSource(), removed = vi.fn(), late = vi.fn(), cancelled = vi.fn();
  source.token.onCancellationRequested(removed).dispose(); source.token.onCancellationRequested(cancelled);
  source.dispose(true); expect(cancelled).toHaveBeenCalledOnce(); expect(removed).not.toHaveBeenCalled();
  const context = { called: vi.fn() };
  source.token.onCancellationRequested(function (this: typeof context) { this.called(); }, context);
  source.token.onCancellationRequested(late).dispose();
  expect(context.called).not.toHaveBeenCalled(); vi.runAllTimers();
  expect(context.called).toHaveBeenCalledOnce(); expect(late).not.toHaveBeenCalled();
});
