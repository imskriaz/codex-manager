import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  fork: worker.fork
}));
import { extractOfficeDocument } from '../src/services/officeDocuments';

afterEach(() => vi.useRealTimers());
function parser() {
  const child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() });
  worker.fork.mockReturnValue(child);
  return child;
}
const data = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

it('bounds workbook reads, terminates the worker and ignores late completion', async () => {
  vi.useFakeTimers();
  const child = parser(), original = Buffer.from(data);
  const pending = extractOfficeDocument('source.xlsx', data);
  const failed = expect(pending).rejects.toThrow('specific worksheet and row range');
  await vi.advanceTimersByTimeAsync(30000); await failed;
  child.emit('message', {text:'late'}); child.emit('exit', 0);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(data).toEqual(original);
});

it.each([null, {}, {text:42}])('reports malformed reader replies without crashing the host: %s', async value => {
  const child = parser(), pending = extractOfficeDocument('source.xlsx', data);
  child.emit('message', value);
  await expect(pending).rejects.toThrow('did not finish');
  expect(child.kill).toHaveBeenCalledOnce();
});

it('preserves parser errors and does not report partial output as success', async () => {
  const child = parser(), pending = extractOfficeDocument('source.xlsx', data);
  child.emit('message', {error:'Worksheet not found. Available worksheets: Detail'});
  await expect(pending).rejects.toThrow('Worksheet not found');
});
it('gives files above 10 MB a bounded two-minute parser deadline',async()=>{
 vi.useFakeTimers();const child=parser(),large=Buffer.alloc(11*1048576);data.copy(large);
 let settled=false;const pending=extractOfficeDocument('large.xlsx',large).finally(()=>{settled=true;});
 const failed=expect(pending).rejects.toThrow('120 seconds');
 await vi.advanceTimersByTimeAsync(30000);expect(settled).toBe(false);
 await vi.advanceTimersByTimeAsync(90000);await failed;expect(child.kill).toHaveBeenCalledOnce();
});
