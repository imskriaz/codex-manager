export async function emailUiFixture(context, address = '') {
  const state = { preferences: { revision: '', enabled: false, address, ready: true, needsAnswer: true, failed: true, includeResult: false }, watches: [], available: true };
  let config = { revision: '', enabled: true, host: 'smtp.example.test', port: 587, security: 'starttls', user: 'sender', hasPassword: true, from: 'sender@example.test', baseUrl: '' };
  let failTest = true;
  const calls = [];
  await context.route('**/api/email/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const body = method === 'GET' ? undefined : route.request().postDataJSON(); calls.push({ path, method, body });
    if (path.endsWith('/smtp')) {
      if (method === 'PUT') { const { password, clearPassword, ...publicConfig } = body; config = { ...publicConfig, hasPassword: !clearPassword && (!!password || config.hasPassword), revision: crypto.randomUUID() }; }
      return route.fulfill({ json: { config, message: 'SMTP settings saved.' } });
    }
    if (path.endsWith('/test')) {
      if (failTest) { failTest = false; return route.fulfill({ status: 503, json: { error: 'SMTP authentication failed. Check the username and app password.' } }); }
      return route.fulfill({ json: { message: 'Test email accepted by the SMTP server. Check your inbox.' } });
    }
    if (method === 'PUT') state.preferences = { ...body, revision: crypto.randomUUID() };
    if (method === 'POST') state.watches = body.enabled ? [...new Set([...state.watches, body.sessionKey])] : state.watches.filter(key => key !== body.sessionKey);
    return route.fulfill({ json: { ...state, message: 'Email preferences saved.' } });
  });
  return { state, calls };
}
