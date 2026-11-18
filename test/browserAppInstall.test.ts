import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../webview-src/dashboard/browserAppInstall.tsx', import.meta.url), 'utf8');

describe('browser app installation', () => {
  it('keeps installation user initiated and reports every terminal outcome', () => {
    expect(source).toContain('prompt.prompt()');
    expect(source).toContain("result.outcome === 'accepted'");
    expect(source).toContain("'Installation cancelled.'");
    expect(source).toContain('Installation failed.');
    expect(source).toContain('Installation was not confirmed in time');
  });

  it('provides browser menu guidance when a prompt is unavailable', () => {
    expect(source).toContain('Chrome or Edge menu > Install Codex Manager');
    expect(source).toContain('Safari Share > Add to Home Screen');
    expect(source).toContain('App installation requires HTTPS or localhost');
  });

  it('only renders install controls when the browser exposes an install prompt', () => {
    expect(source).toContain('!app.installed && (app.available || app.busy)');
  });
});
