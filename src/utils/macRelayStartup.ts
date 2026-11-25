import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const LABEL = 'com.codex-manager.always-online';
const agentPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const xml = (value: string) => value.replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
const run = (executable: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(executable, args, { windowsHide: true, timeout: 3000 }, error => error ? reject(error instanceof Error ? error : new Error(`${executable} failed.`)) : resolve());
});

/** Register for the next user login without interrupting the current host. */
export async function installMacRelayStartup(configPath: string, scriptPath: string, executable: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('Set up macOS startup from your signed-in user account, without sudo.');
  if (![configPath, scriptPath, executable].every(value => path.isAbsolute(value))) throw new Error('macOS startup requires absolute runtime, script and configuration paths.');
  const file = agentPath();
  const temporary = `${file}.pending`;
  const log = path.join(path.dirname(configPath), 'always-online-relay-launchd.log');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${[executable, scriptPath, '--config', configPath].map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>EnvironmentVariables</key><dict>
<key>ELECTRON_RUN_AS_NODE</key><string>1</string>
<key>PATH</key><string>${xml(process.env['PATH'] || '/usr/bin:/bin:/usr/sbin:/sbin')}</string>
</dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await run('/usr/bin/plutil', ['-lint', temporary]);
    await run('/bin/launchctl', ['enable', `gui/${uid}/${LABEL}`]);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removeMacRelayStartup(): Promise<void> {
  // Keep the active host and its sessions alive; removing the plist prevents the next login launch.
  await fs.unlink(agentPath()).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}
