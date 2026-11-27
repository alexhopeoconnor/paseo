import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UUID } from "builder-util-runtime";
import { describe, expect, it, vi } from "vitest";

const { autoUpdaterMock, getAutoUpdaterMock, getAllWindowsMock, desktopSettingsMock } = vi.hoisted(
  () => {
    const handlers = new Map<string, Set<(value: unknown) => void>>();
    return {
      getAutoUpdaterMock: vi.fn(),
      getAllWindowsMock: vi.fn<() => unknown[]>(() => []),
      desktopSettingsMock: {
        mode: "automatic" as "automatic" | "notify" | "off",
        error: null as Error | null,
      },
      autoUpdaterMock: {
        handlers: {
          get: (event: string) => (value: unknown) => {
            for (const listener of handlers.get(event) ?? []) {
              listener(value);
            }
          },
        },
        logger: {
          debug: vi.fn(),
          error: vi.fn((message: unknown) => console.error(message)),
          info: vi.fn(),
          warn: vi.fn(),
        },
        checkForUpdates: vi.fn(),
        downloadUpdate: vi.fn(),
        on: vi.fn((event: string, handler: (value: unknown) => void) => {
          let set = handlers.get(event);
          if (!set) {
            set = new Set();
            handlers.set(event, set);
          }
          set.add(handler);
        }),
        removeListener: vi.fn((event: string, handler: (value: unknown) => void) => {
          handlers.get(event)?.delete(handler);
        }),
        quitAndInstall: vi.fn(),
      },
    };
  },
);

vi.mock("electron", () => ({
  app: {
    // No userData path: update pacing has no state file here, so it paces nothing.
    getPath: vi.fn(),
    isPackaged: true,
  },
  autoUpdater: undefined,
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => {
      if (desktopSettingsMock.error) {
        throw desktopSettingsMock.error;
      }
      return {
        releaseChannel: "stable",
        updates: { mode: desktopSettingsMock.mode },
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
      };
    },
  }),
}));

vi.mock("electron-updater", () => ({
  get autoUpdater() {
    getAutoUpdaterMock();
    return autoUpdaterMock;
  },
}));

import {
  broadcastDownloadProgress,
  checkForAppUpdate,
  createAppUpdateLifecycleLogger,
  downloadAndInstallUpdate,
  installAppUpdateOnQuit,
  resolveStagingUserId,
  runElectronQuitAndInstall,
  shouldInstallAppUpdateOnQuit,
  shouldUseWindowProgressBar,
} from "./auto-updater";

describe("checkForAppUpdate", () => {
  it("does not construct an updater or contact a channel for a workstation-managed build", async () => {
    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: false,
      readyToInstall: false,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      body: null,
      date: null,
      errorMessage: null,
    });
    expect(getAutoUpdaterMock).not.toHaveBeenCalled();
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
  });

  it("blocks manual and quit-time installation without closing the application", async () => {
    const beforeQuit = vi.fn();
    const result = await downloadAndInstallUpdate(
      {
        currentVersion: "1.2.3",
        releaseChannel: "stable",
      },
      beforeQuit,
    );
    expect(result.installed).toBe(false);
    expect(result.message).toContain("workstation package manager");
    expect(
      await installAppUpdateOnQuit({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        signal: new AbortController().signal,
      }),
    ).toBe(false);
    expect(getAutoUpdaterMock).not.toHaveBeenCalled();
    expect(beforeQuit).not.toHaveBeenCalled();
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it("forwards download progress to window bars on non-darwin platforms and avoids idle clears", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const setProgressBar = vi.fn();
    const send = vi.fn();
    try {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, setProgressBar, webContents: { send } },
      ]);

      broadcastDownloadProgress({
        version: "1.2.6",
        percent: 42,
        transferred: 420,
        total: 1000,
        bytesPerSecond: 100,
      });

      expect(setProgressBar).toHaveBeenCalledWith(0.42);
      expect(send).toHaveBeenCalledWith("paseo:event:app-update-download-progress", {
        version: "1.2.6",
        percent: 42,
        transferred: 420,
        total: 1000,
        bytesPerSecond: 100,
      });

      broadcastDownloadProgress(null);
      expect(setProgressBar).toHaveBeenLastCalledWith(-1);
      expect(setProgressBar).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith("paseo:event:app-update-download-progress", null);

      // A subsequent idle clear (e.g., switching channels) must not call setProgressBar(-1) again.
      broadcastDownloadProgress(null);
      expect(setProgressBar).toHaveBeenCalledTimes(2);
    } finally {
      getAllWindowsMock.mockReturnValue([]);
      platformSpy.mockRestore();
    }
  });

  it("skips window progress bars on darwin while still forwarding renderer events", () => {
    expect(shouldUseWindowProgressBar("darwin")).toBe(false);
    expect(shouldUseWindowProgressBar("win32")).toBe(true);
    expect(shouldUseWindowProgressBar("linux")).toBe(true);

    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const setProgressBar = vi.fn();
    const send = vi.fn();
    try {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, setProgressBar, webContents: { send } },
      ]);

      broadcastDownloadProgress({
        version: "1.2.11",
        percent: 55,
        transferred: 550,
        total: 1000,
        bytesPerSecond: 100,
      });
      broadcastDownloadProgress(null);

      expect(setProgressBar).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("paseo:event:app-update-download-progress", {
        version: "1.2.11",
        percent: 55,
        transferred: 550,
        total: 1000,
        bytesPerSecond: 100,
      });
      expect(send).toHaveBeenLastCalledWith("paseo:event:app-update-download-progress", null);
    } finally {
      getAllWindowsMock.mockReturnValue([]);
      platformSpy.mockRestore();
    }
  });

  it("keeps the managed build blocked for every desktop update mode and intent", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      getAutoUpdaterMock.mockClear();
      autoUpdaterMock.checkForUpdates.mockClear();
      for (const mode of ["automatic", "notify", "off"] as const) {
        desktopSettingsMock.mode = mode;
        for (const intent of ["automatic", "manual"] as const) {
          const result = await checkForAppUpdate({
            currentVersion: "1.2.3",
            releaseChannel: "stable",
            intent,
          });
          expect(result).toMatchObject({
            hasUpdate: false,
            readyToInstall: false,
            latestVersion: "1.2.3",
          });
        }
      }

      desktopSettingsMock.error = new SyntaxError("Unexpected token } in JSON");
      expect(
        await checkForAppUpdate({
          currentVersion: "1.2.3",
          releaseChannel: "stable",
          intent: "automatic",
        }),
      ).toMatchObject({ hasUpdate: false, latestVersion: "1.2.3" });

      expect(getAutoUpdaterMock).not.toHaveBeenCalled();
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    } finally {
      desktopSettingsMock.mode = "automatic";
      desktopSettingsMock.error = null;
      consoleWarn.mockRestore();
    }
  });

  it("does not fail progress forwarding when setProgressBar throws", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const send = vi.fn();
    try {
      getAllWindowsMock.mockReturnValue([
        {
          isDestroyed: () => false,
          setProgressBar: () => {
            throw new Error("unsupported desktop environment");
          },
          webContents: { send },
        },
      ]);

      expect(() =>
        broadcastDownloadProgress({
          version: "1.2.7",
          percent: 50,
          transferred: 50,
          total: 100,
          bytesPerSecond: 10,
        }),
      ).not.toThrow();
      expect(send).toHaveBeenCalledWith(
        "paseo:event:app-update-download-progress",
        expect.objectContaining({ version: "1.2.7", percent: 50 }),
      );
    } finally {
      getAllWindowsMock.mockReturnValue([]);
      platformSpy.mockRestore();
    }
  });

  it("waits on macOS explicit installs until Squirrel reports an error or signals quit, while returning immediately on quit-time handoff", async () => {
    const updater = Object.assign(new EventEmitter(), {
      quitAndInstall: vi.fn(),
    });
    const nativeUpdater = new EventEmitter();

    const failedInstall = runElectronQuitAndInstall({
      platform: "darwin",
      updater,
      nativeUpdater,
      isSilent: false,
      isForceRunAfter: true,
    });
    expect(
      await Promise.race([failedInstall.then(() => "settled"), Promise.resolve("pending")]),
    ).toBe("pending");

    nativeUpdater.emit("error", new Error("Code signature invalid"));
    await expect(failedInstall).resolves.toEqual({
      started: false,
      errorMessage: "Code signature invalid",
    });
    expect(updater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("before-quit-for-update")).toBe(0);

    const restartInstall = runElectronQuitAndInstall({
      platform: "darwin",
      updater,
      nativeUpdater,
      isSilent: false,
      isForceRunAfter: true,
    });
    nativeUpdater.emit("before-quit-for-update");
    await expect(restartInstall).resolves.toEqual({ started: true });

    // Quit-time install (isForceRunAfter: false) returns immediately so
    // quit-lifecycle owns its separate handoff deadline.
    await expect(
      runElectronQuitAndInstall({
        platform: "darwin",
        updater,
        nativeUpdater,
        isSilent: true,
        isForceRunAfter: false,
      }),
    ).resolves.toEqual({ started: true });
    expect(nativeUpdater.listenerCount("before-quit-for-update")).toBe(0);

    // Explicit install times out cleanly instead of hanging forever if Squirrel never emits.
    await expect(
      runElectronQuitAndInstall({
        platform: "darwin",
        updater,
        nativeUpdater,
        isSilent: false,
        isForceRunAfter: true,
        timeoutMs: 10,
      }),
    ).resolves.toEqual({
      started: false,
      errorMessage: "Timed out waiting for the update installer to start.",
    });
    expect(updater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("before-quit-for-update")).toBe(0);
  });

  it("logs the update handoff with current and selected target versions", () => {
    const info = vi.fn();
    const lifecycleLog = createAppUpdateLifecycleLogger({ info });

    lifecycleLog.checkStarted({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    lifecycleLog.checkCompleted({
      currentVersion: "1.2.3",
      targetVersion: "1.2.5",
      releaseChannel: "stable",
      intent: "manual",
      hasUpdate: true,
      readyToInstall: true,
      errorMessage: null,
    });
    lifecycleLog.updateDownloaded("1.2.4");
    lifecycleLog.downloadRequested("1.2.5");
    lifecycleLog.quitAndInstallRequested({
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });

    expect(info).toHaveBeenCalledWith("[auto-updater] check started", {
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] update downloaded", {
      targetVersion: "1.2.4",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] download requested", {
      targetVersion: "1.2.5",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] quitAndInstall requested", {
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });
  });
});

describe("shouldInstallAppUpdateOnQuit", () => {
  it("keeps Linux AppImage updates on the manual install path", () => {
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: true })).toBe(false);
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "darwin", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "win32", isAppImage: false })).toBe(true);
  });
});

describe("resolveStagingUserId", () => {
  it("creates and then reuses the on-disk staging user id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-updater-id-"));
    const filePath = path.join(tempDir, ".updaterId");

    try {
      const first = await resolveStagingUserId(filePath);
      const stored = (await readFile(filePath, "utf8")).trim();
      const second = await resolveStagingUserId(filePath);

      expect(UUID.check(stored)).toBeTruthy();
      expect(second).toBe(first);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
