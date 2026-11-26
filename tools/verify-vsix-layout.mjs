import './verify-dashboard-modules.mjs';
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import JSZip from 'jszip';

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dependencies = Object.keys(packageJson.dependencies ?? {});
if (dependencies.length === 0) {
  process.exit(0);
}

const vsixPath = process.argv[2] ?? fileURLToPath(new URL(`../${packageJson.name}-${packageJson.version}.vsix`, import.meta.url));
if (!existsSync(vsixPath)) {
  console.error(`VSIX dependency check failed. Package not found: ${vsixPath}`);
  process.exit(1);
}

const archive = await JSZip.loadAsync(readFileSync(vsixPath));
const packagedManifest = archive.file('extension/package.json');
if (!packagedManifest || JSON.parse(await packagedManifest.async('string')).version !== packageJson.version) throw new Error('VSIX version does not match package.json. Rebuild before installing.');
const paths = new Set(Object.keys(archive.files));
const listing = [...paths].join("\n");
if (/^extension\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\//m.test(listing)) throw new Error('VSIX contains a bundled Claude runtime. Claude sessions must use the locally installed CLI.');
if (listing.split('\n').some(file => /(?:localDictation\.|local-whisper\.py)/.test(file))) throw new Error('VSIX contains the removed local dictation runtime. Clean stale build output and package again.');
for (const file of ['start-node.cjs', 'standalone-config.cjs', 'standalone-supervisor.cjs', 'update-standalone.cjs', 'local-mcp.cjs', 'codex-owner-bridge.cjs', 'codex-owner-launcher.cs'])
  if (!listing.split('\n').includes(`extension/tools/${file}`)) throw new Error(`VSIX standalone launcher is missing: ${file}`);
for (const file of ['extension/AGENTS.md', 'extension/WORKSPACE-GOAL.md', 'extension/pending_log.md', 'extension/PROJECT_LOG.md'])
  if (listing.split('\n').includes(file)) throw new Error(`VSIX contains internal workspace notes: ${file}`);
for (const file of ["extension/tools/inspect-session-writers.ps1", "extension/tools/inspect-codex-storage.cjs", "extension/media/webview/dashboard/dashboard-manifest.json", "extension/tools/codex-manager-mcp.mjs", "extension/skills/codex-manager/SKILL.md", "extension/skills/codex-manager/references/connection.md", "extension/skills/codex-manager/references/browser-debugging.md", "extension/docs/ai-control.md"])
  if (!listing.split("\n").includes(file)) throw new Error(`VSIX runtime asset is missing: ${file}`);
for (const panel of ["workspaceCodeEditor", "workspaceTerminal", "workspaceBrowser"])
  if (!listing.split("\n").some(name => name.startsWith(`extension/media/webview/dashboard/chunks/${panel}-`) && name.endsWith(".js"))) throw new Error(`VSIX lazy panel is missing: ${panel}`);
if (dependencies.includes('node-pty')) {
  const binaries = ['win32-x64/conpty.node','win32-x64/conpty_console_list.node','win32-x64/conpty/conpty.dll','win32-x64/conpty/OpenConsole.exe','win32-arm64/conpty.node','win32-arm64/conpty_console_list.node','win32-arm64/conpty/conpty.dll','win32-arm64/conpty/OpenConsole.exe','darwin-x64/pty.node','darwin-x64/spawn-helper','darwin-arm64/pty.node','darwin-arm64/spawn-helper'];
  for (const binary of binaries) if (!paths.has(`extension/node_modules/node-pty/prebuilds/${binary}`)) throw new Error(`VSIX terminal backend is incomplete: ${binary}`);
  if ([...paths].some(name => name.startsWith('extension/node_modules/node-pty/') && name.endsWith('.pdb'))) throw new Error('VSIX contains unnecessary terminal debug symbols.');
}
if(dependencies.includes('pdf-parse'))for(const file of ['out/services/officeDocumentWorker.js','media/fonts/NotoSans-Regular.ttf','media/fonts/NotoSansBengali-Regular.ttf','media/fonts/LICENSE-Noto.txt'])if(!listing.split('\n').includes('extension/'+file))throw new Error('VSIX document support is missing: '+file);
if (dependencies.includes('pg') && !listing.split('\n').includes('extension/out/storage/officePostgresWorker.js')) throw new Error('VSIX PostgreSQL driver worker is missing.');
for (const file of ['docx/dist/index.cjs', 'exceljs/excel.js', 'pdf-lib/cjs/index.js', '@pdf-lib/fontkit/dist/fontkit.umd.js', 'pptxgenjs/dist/pptxgen.cjs.js', 'pdf-parse/dist/pdf-parse/cjs/index.cjs', 'pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs', '@anthropic-ai/claude-agent-sdk/sdk.mjs']) {
  if (!paths.has(`extension/node_modules/${file}`)) throw new Error(`VSIX runtime entry point is missing: ${file}`);
}
const redundant = [...paths].find(file => [
  /\/node_modules\/(?:pdfjs-dist\/|node-pty\/build\/|exceljs\/dist\/|pdf-lib\/(?:dist|es)\/)/,
  /\/node_modules\/docx\/dist\/(?!index\.cjs$)/,
  /\/node_modules\/pdf-parse\/dist\/(?!pdf-parse\/cjs\/(?:index\.cjs|pdf\.worker\.mjs)$)/,
  /\/node_modules\/.*\.(?:d\.cts|d\.mts|tsbuildinfo)$/
].some(pattern => pattern.test(file)));
if (redundant) throw new Error(`VSIX contains an unused dependency build: ${redundant}`);
const missing = dependencies.filter((dependency) => {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`^extension/node_modules/${escaped}/`, "m").test(listing);
});

if (missing.length > 0) {
  console.error(`VSIX dependency check failed. Missing bundled runtime dependencies: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`VSIX dependency check passed: ${dependencies.join(", ")}`);
