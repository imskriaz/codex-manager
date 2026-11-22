import JSZip from 'jszip';
import {describe,expect,it} from 'vitest';
import {workspaceZip} from '../src/services/officeArchives';

describe('workspace ZIPs',()=>{
  it('writes a readable ZIP with relative entries',async()=>{
    const archive=workspaceZip([{name:'reports/summary.txt',data:Buffer.from('ready')},{name:'data.csv',data:Buffer.from('a,b\n1,2')}]);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.includes(Buffer.from('reports/summary.txt'))).toBe(true);
    expect(archive.readUInt32LE(archive.length-22)).toBe(0x06054b50);
    const unzipped=await JSZip.loadAsync(archive,{checkCRC32:true});
    expect(await unzipped.file('reports/summary.txt')!.async('string')).toBe('ready');
    expect(await unzipped.file('data.csv')!.async('string')).toBe('a,b\n1,2');
  });
  it('rejects traversal and duplicate entries',()=>{
    expect(()=>workspaceZip([{name:'../secret.txt',data:Buffer.from('x')}])).toThrow('relative');
    expect(()=>workspaceZip([{name:'a.txt',data:Buffer.from('x')},{name:'A.TXT',data:Buffer.from('y')}])).toThrow('unique');
  });
});
