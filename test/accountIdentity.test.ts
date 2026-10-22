import { expect, it, vi } from 'vitest';
const readAuth = vi.hoisted(() => vi.fn());
vi.mock('../src/codex', () => ({ readAuthFile: readAuth }));
import { buildAccountStorageId, readCurrentAuthAccountStorageId } from '../src/utils/accountIdentity';
it('uses the selected auth workspace when legacy tokens omit its claim', async () => {
  const id = 'head.' + Buffer.from(JSON.stringify({ email: 'test@example.test' })).toString('base64url') + '.sig';
  readAuth.mockResolvedValue({ tokens: { id_token: id, access_token: id, account_id: 'workspace' } });
  expect(await readCurrentAuthAccountStorageId()).toBe(buildAccountStorageId('test@example.test', 'workspace'));
  readAuth.mockResolvedValue({ tokens: { id_token: id } });
  expect(await readCurrentAuthAccountStorageId()).toBeUndefined();
});
