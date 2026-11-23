import * as path from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { OfficeStateRow } from './officeStatePolicy';

export const OFFICE_DATABASE_ERROR = 'Workspace storage is unavailable. Please try again. The last change could not be confirmed; refresh before retrying.';

/** A dedicated driver thread preserves the existing synchronous state transactions. */
export class OfficePostgresStore {
  private readonly channel = new MessageChannel();
  private readonly worker: Worker;
  private closed = false;
  private depth = 0;
  get unavailable(): boolean { return this.closed; }

  constructor(url: string, workerFile = path.join(__dirname, 'officePostgresWorker.js')) {
    this.worker = new Worker(workerFile, {workerData: {url, port: this.channel.port2}, transferList: [this.channel.port2]});
    this.worker.on('error', () => { this.closed = true; });
    this.worker.unref();
    this.channel.port1.unref();
  }

  request<T>(operation: string, args: unknown[] = []): T {
    if (this.closed) throw new Error(OFFICE_DATABASE_ERROR);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    this.channel.port1.postMessage({operation, args, signal});
    if (Atomics.wait(signal, 0, 0, 5_000) === 'timed-out') {
      this.close();
      throw new Error(OFFICE_DATABASE_ERROR);
    }
    const result = receiveMessageOnPort(this.channel.port1)?.message as {value?: T; failed?: boolean; code?: string} | undefined;
    if (!result || result.failed) { this.close(); throw new Error(OFFICE_DATABASE_ERROR, {cause: {code: result?.code}}); }
    return result.value as T;
  }

  async migrateAsync(source: string, rows: OfficeStateRow[], requireExisting = false): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (failed: boolean, code?: string) => {
        clearTimeout(timer);
        this.worker.off('error', fail); this.worker.off('exit', fail);
        if (failed) { this.close(); reject(new Error(OFFICE_DATABASE_ERROR, {cause: {code}})); }
        else resolve();
      };
      const fail = () => finish(true);
      const timer = setTimeout(fail, 30_000);
      this.worker.once('error', fail); this.worker.once('exit', fail);
      this.channel.port1.once('message', (result: {failed?: boolean; code?: string}) => finish(result.failed === true, result.code));
      this.channel.port1.postMessage({operation: 'migrate', args: [source, rows, requireExisting], signal: new Int32Array(new SharedArrayBuffer(4))});
    });
  }
  get<T>(namespace: string, key: string): T | undefined { return this.request<T | undefined>('get', [namespace, key]); }
  set(namespace: string, key: string, value: unknown): void {
    const serialized = value === undefined ? undefined : JSON.stringify(value);
    if (value !== undefined && serialized === undefined) throw new Error('The storage value cannot be serialized.');
    this.request('set', [namespace, key, serialized]);
  }
  keys(namespace: string): string[] { return this.request('keys', [namespace]); }
  recent<T>(namespace: string, limit: number): T[] { return this.request('recent', [namespace, limit]); }
  deleteBefore(namespace: string, key: string): void { this.request('deleteBefore', [namespace, key]); }
  begin(): void { this.request('begin', [this.depth]); this.depth++; }
  commit(): void { this.request('commit', [this.depth - 1]); this.depth--; }
  rollback(): void { this.request('rollback', [this.depth - 1]); this.depth--; }
  close(): void { this.closed = true; this.channel.port1.close(); void this.worker.terminate(); }
}
