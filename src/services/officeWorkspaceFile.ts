import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { readWorkspaceFile, resolveWorkspaceProjectPathAsync } from './workspaceTools';

/** New files use exclusive creation; existing files must use revision-checked saves. */
export async function createOfficeWorkspaceFile(projectPath: string | undefined, filePath: string | undefined, content: string | undefined) {
  if (typeof content !== 'string' || !filePath?.trim() || /[\0\r\n]/.test(filePath)) throw new Error('Choose a file name and provide its contents.');
  const limit = getCodexManagerConfiguration().get<number>('workspaceTextFileLimitMb', 10) * 1024 * 1024;
  if (Buffer.byteLength(content, 'utf8') > limit) throw new Error('This file is too large. Create a smaller file.');
  const root = await fs.realpath(await resolveWorkspaceProjectPathAsync(projectPath));
  const target = path.resolve(root, filePath);
  const inside = (candidate: string) => { const relative = path.relative(root, candidate); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  if (!inside(target)) throw new Error('Choose a file inside this project.');
  // Create each missing directory only after validating its real parent.
  let parent = root;
  for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    const directory = path.join(parent, segment);
    try { await fs.mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    parent = await fs.realpath(directory);
    if (parent !== root && !inside(parent)) throw new Error('Choose a file inside this project.');
  }
  if (parent !== root && !inside(parent)) throw new Error('Choose a file inside this project.');
  const destination = path.join(parent, path.basename(target));
  const temporary = path.join(parent, `.${randomUUID()}.codex-manager.tmp`);
  try {
    await fs.writeFile(temporary, content, {encoding: 'utf8', flag: 'wx'});
    await fs.link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This file already exists. Read its latest version before editing.');
    throw error;
  } finally { await fs.rm(temporary, {force: true}); }
  return readWorkspaceFile(root, path.relative(root, destination));
}
