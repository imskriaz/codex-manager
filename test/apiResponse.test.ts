import { expect, it } from 'vitest';
import { formatApiResponse, readApiResponse } from '../webview-src/dashboard/apiResponse';
it('formats successful and denied JSON while preserving non-JSON failure details', async () => {
  expect(formatApiResponse(200, await readApiResponse(new Response('{"messages":[{"status":"completed"}]}')))).toBe('HTTP 200\n{\n  "messages": [\n    {\n      "status": "completed"\n    }\n  ]\n}');
  expect(formatApiResponse(403, { text: '{"error":"No permission"}', truncated: false })).toContain('\n  "error": "No permission"\n');
  expect(formatApiResponse(502, { text: 'Proxy unavailable', truncated: false })).toBe('HTTP 502\nProxy unavailable');
});
it('bounds streamed output, cancels an oversized response and marks the truncation', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(80000))); }, cancel() { cancelled = true; } });
  const body = await readApiResponse(new Response(stream));
  expect(body.text.length).toBe(64000); expect(body.truncated).toBe(true); expect(cancelled).toBe(true);
  expect(formatApiResponse(200, body)).toContain('[Output limited to 64 KB]');
});
it('preserves unicode across chunk boundaries and propagates interrupted streams', async () => {
  const bytes = new TextEncoder().encode('☀');
  const body = await readApiResponse(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 1)); controller.enqueue(bytes.subarray(1)); controller.close(); } })));
  expect(body).toEqual({ text: '☀', truncated: false });
  await expect(readApiResponse(new Response(new ReadableStream({ start(controller) { controller.error(new Error('offline')); } })))).rejects.toThrow('offline');
});
