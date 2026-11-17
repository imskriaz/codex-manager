import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
await mkdir('output/live-audit', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await useWorkspaceDashboardAssets(page, origin);
try {
  await page.goto(`${origin}/workspace`);
  await page.locator('.cli-workspace').waitFor();
  const bounds = await page.evaluate(() => {
    const stack = document.createElement('div');
    stack.className = 'dashboard-notice-stack';
    stack.innerHTML = '<div class="dashboard-notice is-error"><span>Dashboard action failed (502)</span><button aria-label="Close">×</button></div>';
    const connection = document.createElement('aside');
    connection.className = 'dashboard-connection-banner';
    connection.innerHTML = '<span class="dashboard-connection-indicator"></span><span class="dashboard-connection-copy"><strong>Connection interrupted</strong></span><button>Reload</button>';
    document.body.append(stack, connection);
    const notice = stack.firstElementChild.getBoundingClientRect();
    const recovery = connection.getBoundingClientRect();
    return { notice: { width: notice.width, height: notice.height, right: innerWidth - notice.right }, recovery: { width: recovery.width, height: recovery.height, right: innerWidth - recovery.right } };
  });
  assert.ok(bounds.notice.width <= 300 && bounds.notice.height <= 52 && bounds.notice.right >= 8);
  assert.ok(bounds.recovery.width <= 300 && bounds.recovery.height <= 52 && bounds.recovery.right >= 8);
  await page.screenshot({ path: 'output/live-audit/mobile-toast.png' });
  console.log(JSON.stringify({ passed: true, bounds }));
} finally { await browser.close(); }
