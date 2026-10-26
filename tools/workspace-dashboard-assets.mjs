import path from 'node:path';

// Read-only browser checks can exercise a workspace build against the installed host.
export async function useWorkspaceDashboardAssets(page, origin) {
  // Fulfilled navigation responses have no address-space metadata in Chromium.
  await page.context().grantPermissions(['local-network-access'], { origin });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!request.isNavigationRequest() || url.origin !== origin) return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/<script(?=\s+src="\/assets\/(?:dashboard|projectShare|sharedConversation)\.js)/g, '<script type="module"') });
  });
  for (const [asset, file, contentType] of [
    ['browserHost.js', 'media/webview/browserHost.js', 'text/javascript'],
    ['dashboard.js', 'media/webview/dashboard/dashboard.js', 'text/javascript'],
    ['dashboard-manifest.json', 'media/webview/dashboard/dashboard-manifest.json', 'application/json'],
    ['dashboard.css', 'media/webview/quotaSummary.css', 'text/css'],
    ['shared.css', 'media/webview/shared.css', 'text/css']
  ]) await page.route(`**/assets/${asset}*`, route => route.fulfill({ contentType, path: path.resolve(file) }));
  await page.route('**/assets/chunks/*.js', route => {
    const name = new URL(route.request().url()).pathname.slice('/assets/chunks/'.length);
    return /^[A-Za-z0-9_-]+\.js$/.test(name) ? route.fulfill({ contentType: 'text/javascript', path: path.resolve('media/webview/dashboard/chunks', name) }) : route.abort();
  });
}
