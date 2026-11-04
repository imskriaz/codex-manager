import { expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';

it('relays confirmed access to browser and connected PCs, bounds duplicates, and does not echo it upstream', () => {
  const browser={send:vi.fn(),readyState:1,bufferedAmount:0};
  const source={send:vi.fn(),readyState:1},other={send:vi.fn(),readyState:1},upstream={send:vi.fn(),readyState:1};
  const server=Object.assign(Object.create(WebDashboardServer.prototype),{deviceId:'local',sessionAccessEvents:new Map(),webSocketClients:new Set([browser]),peerSockets:new Map([['source',source],['other',other]]),authenticatedPeerSockets:new Set([source,other]),peerSocket:upstream});
  const event={type:'dashboard:codex-session-access',sessionId:'01a04882-d037-7a42-ad24-9afb61901188',access:{mode:'read-only',updatedAt:Date.now()}};
  server.publishSessionAccess(event);
  expect(browser.send).toHaveBeenCalledOnce();expect(upstream.send).toHaveBeenCalledOnce();expect(other.send).toHaveBeenCalledOnce();
  server.publishSessionAccess(event);expect(browser.send).toHaveBeenCalledOnce();
  server.publishSessionAccess({...event,deviceId:'source',access:{mode:'danger-full-access',updatedAt:Date.now()+1}});
  expect(upstream.send).toHaveBeenCalledOnce();expect(source.send).toHaveBeenCalledOnce();expect(other.send).toHaveBeenCalledTimes(2);
  server.publishSessionAccess({...event,access:{mode:'root',updatedAt:Date.now()+2}});expect(browser.send).toHaveBeenCalledTimes(2);
});
