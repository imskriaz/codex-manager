import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { removeTestDirectory } from "./testFilesystem";

describe("auth file persistence", () => {
  it("writes a unique temporary file before replacing auth.json", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-write-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    vi.resetModules();
    const { writeAuthFile } = await import("../src/codex/authFile");

    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ old: true }), "utf8");
    await writeAuthFile({ idToken: "id", accessToken: "access", refreshToken: "refresh" });

    const written = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
    expect(written.tokens.access_token).toBe("access");
    expect((await fs.readdir(codexHome)).filter((name) => name.includes(".tmp.")).length).toBe(0);

    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await removeTestDirectory(codexHome);
  }, 15_000);

  it("recovers a valid staged auth file when auth.json is missing", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-recover-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    vi.resetModules();
    const { readAuthFile } = await import("../src/codex/authFile");

    await fs.writeFile(
      path.join(codexHome, ".auth.json.tmp.crash-recovery"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: { id_token: "id", access_token: "access" }
      }),
      { mode: 0o600 }
    );

    await expect(readAuthFile()).resolves.toMatchObject({ tokens: { access_token: "access" } });
    const recovered = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
    expect(recovered.tokens.access_token).toBe("access");

    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await removeTestDirectory(codexHome);
  }, 15_000);

  it("rejects malformed auth objects and token writes instead of persisting unusable credentials", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-validate-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    vi.resetModules();
    const { readAuthFile, writeAuthFile } = await import("../src/codex/authFile");

    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "only" } }), "utf8");
    await expect(readAuthFile()).resolves.toBeUndefined();
    await expect(writeAuthFile({ idToken: "", accessToken: "access" })).rejects.toThrow("valid id token");
    await expect(fs.readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toContain('"access_token":"only"');

    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await removeTestDirectory(codexHome);
  }, 15_000);

  it("never substitutes a staged credential for an existing malformed auth.json", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-preserve-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    vi.resetModules();
    const { readAuthFile } = await import("../src/codex/authFile");
    const authPath = path.join(codexHome, "auth.json");

    await fs.writeFile(authPath, "{partial", "utf8");
    await fs.writeFile(
      path.join(codexHome, ".auth.json.tmp.stale"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: { id_token: "stale-id", access_token: "stale-access" }
      }),
      { mode: 0o600 }
    );

    await expect(readAuthFile()).resolves.toBeUndefined();
    await expect(fs.readFile(authPath, "utf8")).resolves.toBe("{partial");

    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await removeTestDirectory(codexHome);
  }, 15_000);
});
