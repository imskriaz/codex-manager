import { expect, it } from 'vitest';
import { parseWorkspaceGitStatus } from '../src/domain/workspaceGitStatus';

it('reads branch tracking and file statuses without splitting spaces, quotes or newlines in paths', () => {
  const status = parseWorkspaceGitStatus('## feature...origin/feature [ahead 2, behind 3]\0 M src/a file.ts\0?? odd\n"name.ts\0R  new name.ts\0old name.ts\0');
  expect(status).toMatchObject({ branch: 'feature', upstream: 'origin/feature', ahead: 2, behind: 3, changes: 3, changedFilesTruncated: false });
  expect(status.changedFiles).toEqual([{ path: 'src/a file.ts', index: ' ', worktree: 'M' }, { path: 'odd\n"name.ts', index: '?', worktree: '?' }, { path: 'new name.ts', originalPath: 'old name.ts', index: 'R', worktree: ' ' }]);
});
it('reports bounded and incomplete previews without inventing complete file names', () => {
  expect(parseWorkspaceGitStatus('## main\0 M first.ts\0 M second.ts\0 M partial', 1)).toMatchObject({ changes: 2, changedFiles: [{ path: 'first.ts' }], changedFilesTruncated: true });
  expect(parseWorkspaceGitStatus('## main\0R  new.ts\0')).toMatchObject({ changes: 0, changedFiles: [], changedFilesTruncated: true });
});
it('handles clean, unborn and detached repositories', () => {
  expect(parseWorkspaceGitStatus('## No commits yet on main\0')).toMatchObject({ branch: 'main', changes: 0, changedFilesTruncated: false });
  expect(parseWorkspaceGitStatus('## HEAD (no branch)\0')).toMatchObject({ branch: 'HEAD (no branch)', changes: 0 });
});
