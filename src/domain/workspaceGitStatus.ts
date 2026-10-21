/** Parse Git's NUL-delimited porcelain format without interpreting file names as lines. */
export function parseWorkspaceGitStatus(output: string, limit = 256) {
  const records = output.split('\0');
  let truncated = records.pop() !== '';
  const header = records[0]?.startsWith('## ') ? records.shift()!.slice(3) : '';
  const branch = header.replace(/^(?:No commits yet on |Initial commit on )/, '').match(/^(.+?)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?$/);
  const files: Array<{ path: string; originalPath?: string; index: string; worktree: string }> = [];
  let changes = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4 || record[2] !== ' ') { truncated = true; continue; }
    const renamed = /[RC]/.test(record.slice(0, 2));
    const originalPath = renamed ? records[++i] : undefined;
    if (renamed && !originalPath) { truncated = true; continue; }
    changes++;
    if (files.length < limit) files.push({ path: record.slice(3), ...(originalPath ? { originalPath } : {}), index: record[0]!, worktree: record[1]! });
  }
  return { branch: branch?.[1] === 'HEAD' ? 'Detached HEAD' : branch?.[1], upstream: branch?.[2],
    ahead: Number(branch?.[3]?.match(/ahead\s+(\d+)/)?.[1] ?? 0), behind: Number(branch?.[3]?.match(/behind\s+(\d+)/)?.[1] ?? 0),
    changes, changedFiles: files, changedFilesTruncated: truncated || changes > files.length };
}
