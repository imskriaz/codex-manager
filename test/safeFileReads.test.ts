import { promises as fs } from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {readSafeFileSnapshot} from '../src/utils/safeFileReads';

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function handle(size:number,read:FileHandle['read']){
  const file={stat:vi.fn(async()=>({size,mtimeMs:1,isFile:()=>true})),read,close:vi.fn(async()=>undefined)};
  vi.spyOn(fs,'open').mockResolvedValue(file as unknown as FileHandle);return file;
}
describe('bounded file snapshots',()=>{
  it('reads a large tail within the deadline without hundreds of small I/O operations',async()=>{
    vi.useFakeTimers();
    const size=32*1024*1024,limit=25*1024*1024;
    const read=vi.fn((buffer:Buffer,offset:number,length:number,position:number)=>new Promise(resolve=>setTimeout(()=>{
      expect(position+length).toBeLessThanOrEqual(size);buffer.fill(97,offset,offset+length);resolve({bytesRead:length,buffer});
    },30)));
    const file=handle(size,read as never),pending=readSafeFileSnapshot('fixture.jsonl',{maxBytes:limit,startOffset:stat=>stat.size-limit});
    await vi.advanceTimersByTimeAsync(1000);const result=await pending;
    expect(result.bytesRead).toBe(limit);expect(result.startOffset).toBe(size-limit);expect(result.endOffset).toBe(size);
    expect(read).toHaveBeenCalledTimes(25);expect(result.buffer[limit-1]).toBe(97);expect(file.close).toHaveBeenCalledOnce();
  });
  it('handles partial reads and an early EOF without exposing unfilled memory',async()=>{
    let calls=0;
    const read=vi.fn(async(buffer:Buffer,offset:number,length:number)=>{
      const bytesRead=calls++<2?Math.min(3,length):0;buffer.fill(98,offset,offset+bytesRead);return{bytesRead,buffer};
    });
    const file=handle(20,read as never),result=await readSafeFileSnapshot('fixture.jsonl',{maxBytes:12,startOffset:2});
    expect(result.buffer.toString()).toBe('bbbbbb');expect(result.endOffset).toBe(8);expect(file.close).toHaveBeenCalledOnce();
  });
  it('keeps the timeout and closes the handle when storage stalls',async()=>{
    vi.useFakeTimers();const file=handle(20,vi.fn(()=>new Promise(()=>undefined)) as never);
    const pending=readSafeFileSnapshot('fixture.jsonl',{maxBytes:20});const checked=expect(pending).rejects.toThrow('within 5 seconds');
    await vi.advanceTimersByTimeAsync(5001);await checked;expect(file.close).toHaveBeenCalledOnce();
  });
  it('preserves read errors and closes the handle',async()=>{
    const file=handle(20,vi.fn(async()=>{throw new Error('storage unavailable');}) as never);
    await expect(readSafeFileSnapshot('fixture.jsonl',{maxBytes:20})).rejects.toThrow('storage unavailable');expect(file.close).toHaveBeenCalledOnce();
  });
});
