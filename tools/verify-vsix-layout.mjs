import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dependencies = Object.keys(packageJson.dependencies ?? {});
if (dependencies.length === 0) {
  process.exit(0);
}

const vsixPath = fileURLToPath(new URL(`../${packageJson.name}-${packageJson.version}.vsix`, import.meta.url));
if (!existsSync(vsixPath)) {
  console.error(`VSIX dependency check failed. Package not found: ${vsixPath}`);
  process.exit(1);
}

const listing = listZipEntries(readFileSync(vsixPath)).join("\n");
const missing = dependencies.filter((dependency) => {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`^extension/node_modules/${escaped}/`, "m").test(listing);
});

if (missing.length > 0) {
  console.error(`VSIX dependency check failed. Missing bundled runtime dependencies: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`VSIX dependency check passed: ${dependencies.join(", ")}`);

function listZipEntries(archive) {
  const endSignature = 0x06054b50;
  const directorySignature = 0x02014b50;
  const minimumEndOffset = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("VSIX dependency check failed. ZIP end record was not found.");

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== directorySignature) {
      throw new Error(`VSIX dependency check failed. Invalid ZIP directory entry ${index + 1}.`);
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > archive.length) {
      throw new Error(`VSIX dependency check failed. Truncated ZIP directory entry ${index + 1}.`);
    }
    entries.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset = nextOffset;
  }
  if (offset !== endOffset) throw new Error("VSIX dependency check failed. ZIP directory is incomplete.");
  return entries;
}
