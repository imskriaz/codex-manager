import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { DashboardState } from "../src/domain/dashboard/types";

const { buildDashboardStateMock, backfillMissingResetCreditExpiriesMock } = vi.hoisted(() => ({
  buildDashboardStateMock: vi.fn(),
  backfillMissingResetCreditExpiriesMock: vi.fn()
}));

vi.mock("../src/application/dashboard/buildDashboardState", () => ({
  buildDashboardState: buildDashboardStateMock
}));

vi.mock("../src/presentation/dashboard/resetCreditsBackfill", () => ({
  backfillMissingResetCreditExpiries: backfillMissingResetCreditExpiriesMock
}));

import * as usageHistory from "../src/services/dashboardUsageHistory";
import { DashboardPanelController, publishDashboardSnapshot } from "../src/presentation/dashboard/panel";

beforeEach(()=>{
  buildDashboardStateMock.mockReset();backfillMissingResetCreditExpiriesMock.mockReset();
  Object.assign(vscode.Uri,{joinPath:vi.fn(()=>({fsPath:"icon"}))});
});

function createState(): DashboardState {
  return {
    lang: "en",
    panelTitle: "Quota Summary",
    brandSub: "sub",
    logoUri: "logo",
    settings: {
      dashboardTheme: "dark",
      displayLanguage: "en",
      autoRefreshMinutes: 0,
      autoRefreshCurrentMinutes: 0,
      autoSwitchEnabled: false,
      hourlyQuotaControlEnabled: false,
      autoSwitchReloadWindowEnabled: false,
      autoSwitchHourlyThreshold: 20,
      autoSwitchWeeklyThreshold: 20,
      autoSwitchLockMinutes: 0,
      quotaWarningEnabled: false,
      quotaWarningThreshold: 20,
      quotaWarningWeeklyThreshold: 20,
      quotaGreenThreshold: 60,
      quotaYellowThreshold: 20,
      codexAppRestartEnabled: false,
      codexAppRestartMode: "manual",
      codexAppPath: "",
      resolvedCodexAppPath: ""
    },
    copy: {} as DashboardState["copy"],
    tokenAutomation: {
      enabled: true
    },
    indexHealth: {
      status: "healthy",
      availableBackups: 0
    },
    accounts: [
      {
        id: "account-1",
        email: "dev@example.com",
        displayName: "dev@example.com",
        tags: [],
        planTypeLabel: "Plus",
        isActive: true,
        showInStatusBar: false,
        healthKind: "healthy",
        dismissedHealth: false,
        metrics: [],
        resetCreditsAvailable: 1
      } as DashboardState["accounts"][number]
    ]
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    })
  ]);
}

function createContext(dailyUsageCache: unknown = []) {
  return {
    globalState: {
      get: vi.fn((key: string) => (key === "codexManager.dashboardDailyUsageCache.v1" ? dailyUsageCache : undefined)),
      update: vi.fn(async () => undefined)
    }
  } as never;
}

describe("publishDashboardSnapshot", () => {
  function controller() {
    const postMessage=vi.fn(async()=>true);
    const panel={title:"",webview:{postMessage,asWebviewUri:()=>({toString:()=>"logo"})}};
    const instance=Object.assign(Object.create(DashboardPanelController.prototype),{
      panel,webviewReady:true,panelRevision:0,forcePublish:false,publishAgain:false,
      context:{...createContext() as object,extensionUri:{fsPath:"extension"}},repo:{},settingsStore:{}
    }) as {publishState(force?:boolean):Promise<void>;panel:unknown;panelRevision:number};
    return{instance,panel,postMessage};
  }

  it("publishes the webview when optional usage history is still saving", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(usageHistory, "appendDashboardUsageSnapshot").mockReturnValue(new Promise(() => undefined));
    const postMessage = vi.fn(async () => true);
    buildDashboardStateMock.mockResolvedValue(createState());
    backfillMissingResetCreditExpiriesMock.mockResolvedValue(false);
    try {
      const work = publishDashboardSnapshot({ context: createContext(), repo: {} as never, settingsStore: {} as never, logoUri: "logo", setPanelTitle: vi.fn(), postMessage, schedulePublishState: vi.fn() });
      await vi.advanceTimersByTimeAsync(250);
      await work;
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "dashboard:snapshot" }));
    } finally { write.mockRestore(); vi.useRealTimers(); }
  });

  it("joins concurrent refreshes and publishes only the newest requested snapshot",async()=>{
    const {instance,postMessage}=controller();let release!:(state:DashboardState)=>void;
    const newest={...createState(),brandSub:"latest"};
    buildDashboardStateMock.mockImplementationOnce(()=>new Promise<DashboardState>(resolve=>{release=resolve;})).mockResolvedValue(newest);
    backfillMissingResetCreditExpiriesMock.mockResolvedValue(false);
    const first=instance.publishState();await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    const second=instance.publishState(true);release(createState());await Promise.all([first,second]);
    expect(postMessage).toHaveBeenCalledOnce();expect(postMessage.mock.calls[0]?.[0].state.brandSub).toBe("latest");
  });

  it("does not send a completed old read into a replacement panel",async()=>{
    const {instance,postMessage}=controller();let release!:(state:DashboardState)=>void;
    buildDashboardStateMock.mockImplementationOnce(()=>new Promise<DashboardState>(resolve=>{release=resolve;}));
    backfillMissingResetCreditExpiriesMock.mockResolvedValue(false);
    const publish=instance.publishState();await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    instance.panel={webview:{postMessage:vi.fn()}};instance.panelRevision++;
    release(createState());await publish;expect(postMessage).not.toHaveBeenCalled();
  });

  it("publishes the current snapshot without waiting for reset credits backfill", async () => {
    const state = createState();
    let resolveBackfill: (value: boolean) => void = () => undefined;

    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBackfill = resolve;
        })
    );

    const setPanelTitle = vi.fn();
    const postMessage = vi.fn(async () => true);
    const schedulePublishState = vi.fn();

    const result = await withTimeout(
      publishDashboardSnapshot({
        context: createContext(),
        repo: {} as never,
        settingsStore: {} as never,
        logoUri: "logo",
        setPanelTitle,
        postMessage,
        schedulePublishState
      }),
      50
    );

    expect(result).not.toBe("timeout");
    expect(setPanelTitle).toHaveBeenCalledWith("Quota Summary");
    expect(postMessage).toHaveBeenCalledWith({
      type: "dashboard:snapshot",
      state: { ...state, onboardingCompleted: true, usageSummary: { revision: 0, count: 0 } }
    });
    expect(schedulePublishState).not.toHaveBeenCalled();

    resolveBackfill(true);
  });

  it("schedules a follow-up publish after backfill updates the repository", async () => {
    const state = createState();
    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockImplementation(async (_repo, _accounts, onUpdated) => {
      onUpdated();
      return true;
    });

    const schedulePublishState = vi.fn();

    await publishDashboardSnapshot({
      context: createContext(),
      repo: {} as never,
      settingsStore: {} as never,
      logoUri: "logo",
      setPanelTitle: vi.fn(),
      postMessage: vi.fn(async () => true),
      schedulePublishState
    });

    await Promise.resolve();

    expect(schedulePublishState).toHaveBeenCalledTimes(1);
  });

  it("publishes only usage metadata and leaves daily history in storage", async () => {
    const state = createState();
    const dailyUsageCache = [
      {
        accountId: "account-1",
        fetchedAt: 123,
        usage: { days: 1, points: [{ date: "2026-08-28", totalTokens: 42 }] }
      }
    ];
    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockResolvedValue(false);
    const postMessage = vi.fn(async () => true);

    await publishDashboardSnapshot({
      context: createContext(dailyUsageCache),
      repo: {} as never,
      settingsStore: {} as never,
      logoUri: "logo",
      setPanelTitle: vi.fn(),
      postMessage,
      schedulePublishState: vi.fn()
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "dashboard:snapshot",
      state: { ...state, onboardingCompleted: true, usageSummary: { revision: 0, count: 0 } }
    });
  });
});
