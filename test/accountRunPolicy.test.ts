import { describe, expect, it } from "vitest";
import { canRunAccountOnThisPc } from "../webview-src/dashboard/accountRunPolicy";

describe("dashboard account run policy", () => {
  it("allows manually switching an account claimed by another PC", () => {
    expect(
      canRunAccountOnThisPc(
        {
          enabled: false,
          runningDeviceName: "Office PC",
          runningOnThisDevice: false
        },
        false
      )
    ).toBe(true);
  });

  it("blocks another switch while a dashboard action is busy", () => {
    expect(canRunAccountOnThisPc({ enabled: true }, true)).toBe(false);
  });

  it("allows a foreign claim without requiring emergency bypass", () => {
    const account = {
      enabled: true,
      runningDeviceName: "Office PC",
      runningOnThisDevice: false
    };

    expect(canRunAccountOnThisPc(account, false)).toBe(true);
    expect(canRunAccountOnThisPc(account, false, true)).toBe(true);
  });

  it("allows manual switching of a locally disabled account", () => {
    const account = {
      enabled: false,
      runningDeviceName: "Office PC",
      runningOnThisDevice: false
    };

    expect(canRunAccountOnThisPc(account, false)).toBe(true);
    expect(canRunAccountOnThisPc(account, false, true)).toBe(true);
    expect(canRunAccountOnThisPc({ enabled: false }, false, true)).toBe(true);
    expect(canRunAccountOnThisPc({ enabled: false }, false)).toBe(true);
  });

  it("releases a foreign claim only after that device is confirmed offline", () => {
    const account = {
      enabled: true,
      runningDeviceName: "Office PC",
      runningOnThisDevice: false,
      runningDeviceOnline: false
    };

    expect(canRunAccountOnThisPc(account, false)).toBe(true);
    expect(canRunAccountOnThisPc({ ...account, runningDeviceOnline: undefined }, false)).toBe(true);
    expect(canRunAccountOnThisPc({ ...account, runningDeviceOnline: true }, false)).toBe(true);
  });
});
