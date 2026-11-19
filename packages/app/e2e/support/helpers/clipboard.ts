import type { BrowserContext } from "@playwright/test";

/**
 * Firefox cannot grant `clipboard-read`/`clipboard-write` through Playwright
 * 1.58.2 (`Unknown permission`). Its test-only async clipboard pref bypasses
 * the permission and user-activation checks, while Chromium keeps using the
 * normal permission grant. The pref is scoped to the three clipboard specs.
 */
export const FIREFOX_CLIPBOARD_PREFS: Record<string, boolean> = {
  "dom.events.testing.asyncClipboard": true,
  "dom.events.asyncClipboard.clipboardItem": true,
  "dom.events.asyncClipboard.readText": true,
};

export const firefoxClipboardLaunchOptions = {
  launchOptions: { firefoxUserPrefs: FIREFOX_CLIPBOARD_PREFS },
};

export async function grantClipboardAccess(context: BrowserContext): Promise<void> {
  if (context.browser()?.browserType().name() === "firefox") {
    return;
  }
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}
