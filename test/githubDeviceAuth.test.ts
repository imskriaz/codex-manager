import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

function processFixture() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.spawn.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("remote GitHub device login", () => {
  it("returns a split user code without exposing other CLI output and reuses a pending login", async () => {
    const child = processFixture();
    mocks.spawn.mockReturnValue(child);
    const { connectGitHubDevice } = await import("../src/services/githubDeviceAuth");
    const pending = connectGitHubDevice("C:/project");
    child.stderr.write("secret-that-must-stay-on-host\n! First copy your one-time co");
    child.stderr.write("de: ABCD-1234\n");
    const message = await pending;
    expect(message).toContain("https://github.com/login/device");
    expect(message).toContain("ABCD-1234");
    expect(message).not.toContain("secret-that-must-stay-on-host");
    expect(await connectGitHubDevice("C:/another-project")).toBe(message);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
      "--clipboard=false"
    ]);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, env: { GH_PROMPT_DISABLED: "1" } });
  });

  it("configures Git credentials before reporting successful authentication", async () => {
    const child = processFixture(),
      setup = processFixture();
    mocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(setup);
    const { connectGitHubDevice } = await import("../src/services/githubDeviceAuth");
    const pending = connectGitHubDevice("C:/project");
    child.emit("close", 0);
    expect(mocks.spawn.mock.calls[1]?.[1]).toEqual(["auth", "setup-git", "--hostname", "github.com"]);
    setup.emit("close", 0);
    expect(await pending).toBeUndefined();
  });

  it("reports missing CLI and allows an explicit retry", async () => {
    const child = processFixture();
    mocks.spawn.mockReturnValue(child);
    const { connectGitHubDevice } = await import("../src/services/githubDeviceAuth");
    const pending = connectGitHubDevice("C:/project");
    const failure = expect(pending).rejects.toThrow("Install GitHub CLI on the selected system");
    child.emit("error", Object.assign(new Error("private detail"), { code: "ENOENT" }));
    await failure;
    const retry = connectGitHubDevice("C:/project");
    const retryFailure = expect(retry).rejects.toThrow("cancelled");
    child.emit("close", 1);
    await retryFailure;
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled start and an expired device approval", async () => {
    const child = processFixture();
    mocks.spawn.mockReturnValue(child);
    const { connectGitHubDevice } = await import("../src/services/githubDeviceAuth");
    const pending = connectGitHubDevice("C:/project");
    const failure = expect(pending).rejects.toThrow("did not return a sign-in code");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(child.kill).toHaveBeenCalledOnce();
    const retry = connectGitHubDevice("C:/project");
    child.stderr.write("one-time code: ABCD-1234\n");
    await retry;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await expect(connectGitHubDevice("C:/project")).rejects.toThrow("expired");
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("reports Git helper failure and bounds a stalled helper setup", async () => {
    const child = processFixture(),
      setup = processFixture();
    mocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(setup);
    const { connectGitHubDevice } = await import("../src/services/githubDeviceAuth");
    const pending = connectGitHubDevice("C:/project");
    const failure = expect(pending).rejects.toThrow("Git credential setup timed out");
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(setup.kill).toHaveBeenCalledOnce();
  });
});
