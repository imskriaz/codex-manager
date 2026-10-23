/** Limit inspection output without buffering an unbounded response. */
export async function readApiResponse(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const decoder = new TextDecoder(); let text = '', remaining = 64000;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return { text: text + decoder.decode(), truncated: false };
      text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      remaining -= chunk.value.byteLength;
      if (remaining <= 0) { await reader.cancel(); return { text: text + decoder.decode(), truncated: true }; }
    }
  } finally { reader.releaseLock(); }
}
export function formatApiResponse(status: number, body: { text: string; truncated: boolean }): string {
  let formatted = body.text;
  try { formatted = JSON.stringify(JSON.parse(body.text), null, 2); } catch { /* Keep non-JSON failure details. */ }
  return `HTTP ${status}\n${formatted}${body.truncated ? '\n[Output limited to 64 KB]' : ''}`;
}
