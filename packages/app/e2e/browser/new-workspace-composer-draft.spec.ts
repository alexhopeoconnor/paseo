import type { Page } from "@playwright/test";
import type { SubmissionRecoveryRecord } from "@/stores/workspace-draft-submission-recovery";
import { chooseModel, startWithoutRememberedModel } from "../support/helpers/model-memory";
import {
  composerLocator,
  dropFileOnComposer,
  expectAttachmentPill,
  enterComposerFullscreen,
  exitComposerFullscreen,
  resizeComposerViewport,
} from "../support/helpers/composer";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  delayBrowserWorkspaceCreatedResponse,
  delayBrowserAgentCreatedStatus,
  submitNewWorkspacePrompt,
  expectNewWorkspaceDraft,
  expectNewWorkspaceProjectSelected,
  fillNewWorkspaceDraft,
  openGlobalNewWorkspaceComposer,
  openNewWorkspaceComposer,
  selectNewWorkspaceHost,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const DRAFT = `Please investigate the workspace startup failure.

Trace the request from the app through the daemon, preserve the existing behavior, and explain the root cause before making changes.`;

async function readWorkspaceSubmissionRecords(page: Page, text: string) {
  return page.evaluate(async (expectedText) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("paseo-composer-submission-recovery");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    try {
      const records = await new Promise<SubmissionRecoveryRecord[]>((resolve, reject) => {
        const request = database.transaction("submissions").objectStore("submissions").getAll();
        request.addEventListener(
          "success",
          () => resolve(request.result as SubmissionRecoveryRecord[]),
          { once: true },
        );
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      return records.filter(
        (record) =>
          record.submission.kind === "workspace_create" && record.submission.text === expectedText,
      );
    } finally {
      database.close();
    }
  }, text);
}

test.describe("New workspace composer draft", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps the draft when the project changes", async ({ page }) => {
    const firstProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-project-a-",
    });
    const secondProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-project-b-",
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: firstProject.projectKey,
        projectDisplayName: firstProject.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, firstProject.projectDisplayName);

      await fillNewWorkspaceDraft(page, DRAFT);

      await selectNewWorkspaceProject(page, {
        projectKey: secondProject.projectKey,
        projectDisplayName: secondProject.projectDisplayName,
      });

      await expectNewWorkspaceDraft(page, DRAFT);
    } finally {
      await secondProject.cleanup();
      await firstProject.cleanup();
    }
  });

  test("keeps the draft when the host changes", async ({ page }) => {
    const project: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-host-",
    });
    const secondaryServerId = "new-workspace-draft-secondary-host";

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "Primary host",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: secondaryServerId,
          label: "Secondary host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      await fillNewWorkspaceDraft(page, DRAFT);
      await selectNewWorkspaceHost(page, "Secondary host");

      await expectNewWorkspaceDraft(page, DRAFT);
    } finally {
      await project.cleanup();
    }
  });

  test("does not restore a submitted draft after deferred publication", async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "new-workspace-submitted-draft-" });

    try {
      await startWithoutRememberedModel(page);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });

      await chooseModel(page, "mock", "Ten second stream");
      const composer = page.getByRole("textbox", { name: "Message agent..." });
      const createButton = page.getByTestId("workspace-create-submit");
      await expect(composer).toBeEditable({ timeout: 30_000 });
      await expect(createButton).toBeEnabled({ timeout: 30_000 });

      await composer.evaluate((element, draft) => {
        if (!(element instanceof HTMLTextAreaElement)) {
          throw new Error("Composer input is not a textarea");
        }
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (!valueSetter) throw new Error("Textarea value setter is unavailable");
        valueSetter.call(element, draft);
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: draft,
            inputType: "insertText",
          }),
        );
        const button = document.querySelector('[data-testid="workspace-create-submit"]');
        if (!(button instanceof HTMLElement)) {
          throw new Error("Create button is unavailable");
        }
        button.click();
      }, DRAFT);

      await page.waitForURL((url) => url.pathname.includes("/workspace/"), { timeout: 30_000 });
      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceDraft(page, "");
    } finally {
      await project.cleanup();
    }
  });
});

test("fullscreen creation returns inline and keeps submission locked when reopened", async ({
  page,
}) => {
  const project = await seedWorkspace({ repoPrefix: "fullscreen-submit-pending-" });
  const delay = await delayBrowserWorkspaceCreatedResponse(page);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await resizeComposerViewport(page, "portrait");
    await fillNewWorkspaceDraft(page, DRAFT);
    await enterComposerFullscreen(page);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await delay.waitForCreateRequest();

    await test.step("submission returns inline with the original draft and spinner", async () => {
      await expect(page.getByTestId("composer-fullscreen")).toHaveCount(0);
      await expect(composerLocator(page)).toHaveValue(DRAFT);
      await expect(composerLocator(page)).not.toBeEditable();
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
      await expect(page.getByRole("progressbar")).toBeVisible();
    });
    await test.step("fullscreen can reopen while pending without unlocking or duplicating submission", async () => {
      await enterComposerFullscreen(page);
      await expect(page.getByTestId("composer-fullscreen")).toBeVisible();
      await expect(composerLocator(page)).toHaveValue(DRAFT);
      await expect(composerLocator(page)).not.toBeEditable();
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
      await expect(page.getByRole("progressbar")).toBeVisible();
      await exitComposerFullscreen(page);
    });
    delay.release();
    await page.waitForURL((url) => url.pathname.includes("/workspace/"));
    await expect(composerLocator(page)).toHaveValue("");
    await expect(composerLocator(page)).toBeEditable();
    expect(delay.agentRequests).toHaveLength(1);
  } finally {
    delay.release();
    await project.cleanup();
  }
});

test("keeps creation outcome reviewable when acknowledgement fails after navigation", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({ repoPrefix: "new-workspace-unknown-ack-", git: false });
  const delay = await delayBrowserAgentCreatedStatus(page, { requireLocalWorkspace: true });
  const prompt = "Keep this exact initial prompt after the workspace navigation.";
  const attachment = {
    name: "acknowledgement-context.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Exact retained creation context\n"),
  };
  try {
    await startWithoutRememberedModel(page);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: project.projectKey,
      projectDisplayName: project.projectDisplayName,
    });
    await chooseModel(page, "mock", "Ten second stream");
    await dropFileOnComposer(page, attachment);
    await expectAttachmentPill(page, "composer-file-attachment-pill");
    await submitNewWorkspacePrompt(page, prompt);
    await delay.waitForDelayedCreatedStatus();
    await page.waitForURL((url) => url.pathname.includes("/workspace/"));
    await expect.poll(() => readWorkspaceSubmissionRecords(page, prompt)).toHaveLength(1);
    const [before] = await readWorkspaceSubmissionRecords(page, prompt);
    expect(before!.state).toBe("dispatching");
    expect(before!.originalDraft.text).toBe(prompt);
    expect(before!.originalDraft.attachments).toHaveLength(1);

    delay.reject("Initial-agent acknowledgement lost after workspace publication");
    await expect
      .poll(async () => (await readWorkspaceSubmissionRecords(page, prompt))[0]?.state)
      .toBe("needs_review");
    const [failed] = await readWorkspaceSubmissionRecords(page, prompt);
    expect(failed).toMatchObject({
      id: before!.id,
      clientMessageId: before!.clientMessageId,
      originalDraft: before!.originalDraft,
      state: "needs_review",
    });
    expect(failed!.acceptedAt).toBeUndefined();

    await page.reload();
    await waitForSidebarHydration(page);
    const [recovered] = await readWorkspaceSubmissionRecords(page, prompt);
    expect(recovered).toMatchObject({
      id: before!.id,
      originalDraft: before!.originalDraft,
      state: "needs_review",
    });
    expect(recovered!.acceptedAt).toBeUndefined();
    delay.expectSingleWorkspaceIntent();
  } finally {
    delay.release();
    await project.cleanup();
  }
});
