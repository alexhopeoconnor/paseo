import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { SessionInfo } from "@opencode/client";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import type { V2Api } from "./opencode/v2/api.js";
import { V2Runtime } from "./opencode/v2/runtime.js";

const EXPECTED_V2_VERSION = "opencode v2.2.5";
const BACKGROUND_CHILD_TITLE = "Paseo native background-child fixture";

function nativeV2Version(): string {
  return execFileSync("opencode-v2", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function completionSse(text = "NATIVE_V2_FIXTURE_OK"): string {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-paseo-native-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: null,
    })}\n\n`;
  return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
}

function subagentToolCallSse(input: {
  agent: string;
  description: string;
  prompt: string;
}): string {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-paseo-native-fixture-subagent",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: null,
    })}\n\n`;
  return `${chunk(
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_paseo_native_fixture_subagent",
          type: "function",
          function: {
            name: "subagent",
            arguments: JSON.stringify({ ...input, background: true }),
          },
        },
      ],
    },
    null,
  )}${chunk({}, "tool_calls")}data: [DONE]\n\n`;
}

function latestUserText(body: unknown): string {
  if (!body || typeof body !== "object" || !("messages" in body)) return "";
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role === "user") return JSON.stringify(content);
  }
  return "";
}

function hasFunctionTool(body: unknown, name: string): boolean {
  if (!body || typeof body !== "object" || !("tools" in body)) return false;
  const tools = (body as { tools?: unknown }).tools;
  return (
    Array.isArray(tools) &&
    tools.some(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        "function" in tool &&
        typeof tool.function === "object" &&
        tool.function !== null &&
        "name" in tool.function &&
        tool.function.name === name,
    )
  );
}

type HeldCompletionKind = "parent" | "child" | "sibling";

interface NativeFamilyPlan {
  childAgent: string;
  childDescription: string;
  parentPrompt: string;
  childPrompt: string;
  siblingPrompt: string;
}

function requestSummary(body: unknown): unknown {
  const request = body as {
    messages?: unknown;
    tools?: Array<{ function?: { name?: unknown } }>;
  };
  return {
    messages: Array.isArray(request.messages)
      ? request.messages.slice(-5).map((message) => {
          if (!message || typeof message !== "object") return message;
          const entry = message as {
            role?: unknown;
            content?: unknown;
            tool_calls?: unknown;
            tool_call_id?: unknown;
          };
          let content: string | undefined;
          if (typeof entry.content === "string") content = entry.content;
          else if (entry.content !== undefined) content = JSON.stringify(entry.content);
          if (content && content.length > 1_000) content = `${content.slice(0, 1_000)}…`;
          return {
            role: entry.role,
            content,
            tool_calls: entry.tool_calls,
            tool_call_id: entry.tool_call_id,
          };
        })
      : request.messages,
    tools: request.tools?.map((tool) => tool.function?.name),
  };
}

async function startLoopbackModel(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  completionRequests: () => number;
  configureNativeFamily: (plan: NativeFamilyPlan) => void;
  heldCompletions: () => number;
  subagentToolCalls: () => number;
  familyRequestSummary: () => unknown;
  finishHeldCompletion: (kind: HeldCompletionKind) => void;
  abortHeldCompletions: (kind?: HeldCompletionKind) => void;
}> {
  let requests = 0;
  let family: NativeFamilyPlan | undefined;
  let parentRequests = 0;
  let subagentToolCalls = 0;
  let parentRequestSummary: unknown;
  const heldResponses = new Map<ServerResponse, HeldCompletionKind>();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests += 1;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "fixture expected JSON completion input" }));
          return;
        }
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        });
        const userText = latestUserText(body);
        let kind: HeldCompletionKind | undefined;
        if (family && userText.includes(family.parentPrompt) && hasFunctionTool(body, "subagent")) {
          parentRequests += 1;
          parentRequestSummary = requestSummary(body);
          if (parentRequests === 1) {
            subagentToolCalls += 1;
            response.end(
              subagentToolCallSse({
                agent: family.childAgent,
                description: family.childDescription,
                prompt: family.childPrompt,
              }),
            );
            return;
          }
          kind = "parent";
        } else if (family && userText.includes(family.childPrompt)) {
          kind = "child";
        } else if (family && userText.includes(family.siblingPrompt)) {
          kind = "sibling";
        }
        if (kind) {
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-paseo-native-fixture-held-family",
              object: "chat.completion.chunk",
              created: 0,
              model: "fixture-model",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "family-running" },
                  finish_reason: null,
                },
              ],
              usage: null,
            })}\n\n`,
          );
          heldResponses.set(response, kind);
          response.once("close", () => heldResponses.delete(response));
          return;
        }
        response.end(completionSse());
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected local fixture request" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected loopback model TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    completionRequests: () => requests,
    configureNativeFamily: (plan) => {
      family = plan;
      parentRequests = 0;
    },
    heldCompletions: () => heldResponses.size,
    subagentToolCalls: () => subagentToolCalls,
    familyRequestSummary: () => ({ parentRequests, lastParent: parentRequestSummary }),
    finishHeldCompletion: (kind) => {
      for (const [response, heldKind] of heldResponses) {
        if (heldKind === kind) response.end(completionSse(`NATIVE_V2_${kind.toUpperCase()}_OK`));
      }
    },
    abortHeldCompletions: (kind) => {
      for (const [response, heldKind] of Array.from(heldResponses)) {
        if (!kind || heldKind === kind) response.destroy();
      }
    },
    close: async () => {
      for (const response of Array.from(heldResponses.keys())) response.destroy();
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function waitFor<T>(
  description: string,
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!predicate(latest)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(25);
    latest = await read();
  }
  return latest;
}

async function sessionLogSummary(client: V2Api, sessionID: string): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of client.session.log({ sessionID, follow: false })) {
    events.push({ type: event.type, data: "data" in event ? event.data : undefined });
  }
  return events;
}

interface NativeSessionTiming {
  id: string;
  parentID: string | undefined;
  outcome: SessionInfo["outcome"] | undefined;
  time: {
    busy: number | undefined;
    idle: number | undefined;
    created: number;
    updated: number;
  };
}

function nativeSessionTiming(info: SessionInfo): NativeSessionTiming {
  // v2.2.5 returns `time.busy`, but the bundled client declaration predates
  // that response field. The fixture records it without broadening the SDK.
  const time = info.time as SessionInfo["time"] & { busy?: unknown };
  return {
    id: info.id,
    parentID: info.parentID,
    outcome: info.outcome,
    time: {
      busy: typeof time.busy === "number" ? time.busy : undefined,
      idle: typeof time.idle === "number" ? time.idle : undefined,
      created: time.created,
      updated: time.updated,
    },
  };
}

function expectFreshInterruptedOutcome(
  before: NativeSessionTiming,
  after: NativeSessionTiming,
): void {
  expect(after.outcome).toBe("interrupted");
  expect(after.time.idle).toEqual(expect.any(Number));
  expect(after.time.idle!).toBeGreaterThan(before.time.idle ?? Number.NEGATIVE_INFINITY);
  if (after.time.busy !== undefined)
    expect(after.time.idle!).toBeGreaterThanOrEqual(after.time.busy);
}

test("native v2.2.5 stops exact settled and never-started sessions and preserves an unrelated active sibling", async () => {
  // This check intentionally fails rather than skips when the checks image
  // does not provide the checksum-pinned native binary.
  expect(nativeV2Version()).toBe(EXPECTED_V2_VERSION);
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-native-"));
  const project = path.join(root, "project");
  const paseoHome = path.join(root, "paseo-home");
  const home = path.join(root, "home");
  const model = await startLoopbackModel();
  const logger = createTestLogger();
  const settings = {
    command: { mode: "replace" as const, argv: ["opencode-v2"] },
    env: {
      HOME: home,
      PASEO_HOME: paseoHome,
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      OPENCODE_DISABLE_AUTO_UPDATE: "1",
    },
  };
  const runtime = new V2Runtime({ logger, settings });
  const client = new OpenCodeV2AgentClient({ logger, settings, runtime });
  let settled: Awaited<ReturnType<typeof client.createSession>> | undefined;
  let idle: Awaited<ReturnType<typeof client.createSession>> | undefined;
  let parent: Awaited<ReturnType<typeof client.createSession>> | undefined;
  let sibling: Awaited<ReturnType<typeof client.createSession>> | undefined;
  let inspector: Awaited<ReturnType<typeof runtime.acquire>> | undefined;
  const cancelledInboxIds: Array<{ sessionID: string; inboxID: string }> = [];
  try {
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify({
        model: "fixture/fixture-model",
        enabled_providers: ["fixture"],
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Paseo native-v2 fixture",
            options: { apiKey: "fixture-key", baseURL: model.baseUrl, timeout: false },
            models: {
              "fixture-model": {
                name: "Fixture model",
                tool_call: true,
                limit: { context: 128_000, output: 8_192 },
              },
            },
          },
        },
      }),
    );

    settled = await client.createSession(
      { provider: "opencode", cwd: project, model: "fixture/fixture-model" },
      { agentId: "native-v2-settled" },
      { persistSession: false },
    );
    const result = await settled.run("Reply with the fixture marker and no tools.");
    expect(result.finalText).toContain("NATIVE_V2_FIXTURE_OK");
    // OpenCode may issue an internal follow-up completion for this model
    // version. The fixture proves its work stayed on the loopback stub, then
    // records the count so native stop and an idle session cannot add work.
    const requestsAfterRun = model.completionRequests();
    expect(requestsAfterRun).toBeGreaterThan(0);
    const settledHandle = settled.describePersistence();
    if (!settledHandle?.nativeHandle) throw new Error("Expected native v2 persistence handle");
    expect(await client.stopNativeSession(settledHandle)).toEqual({ status: "settled" });

    idle = await client.createSession(
      { provider: "opencode", cwd: project, model: "fixture/fixture-model" },
      { agentId: "native-v2-idle" },
      { persistSession: false },
    );
    const idleHandle = idle.describePersistence();
    if (!idleHandle?.nativeHandle) throw new Error("Expected idle native v2 persistence handle");
    expect(idleHandle.nativeHandle).not.toBe(settledHandle.nativeHandle);
    expect(await client.stopNativeSession(idleHandle)).toEqual({ status: "settled" });
    expect(model.completionRequests()).toBe(requestsAfterRun);

    inspector = await runtime.acquire();
    const cancelInbox = inspector.client.session.inbox.cancel.bind(inspector.client.session.inbox);
    inspector.client.session.inbox.cancel = async (input, requestOptions) => {
      const cancelled = await cancelInbox(input, requestOptions);
      cancelledInboxIds.push({ sessionID: input.sessionID, inboxID: input.inboxID });
      return cancelled;
    };
    const agents = await inspector.client.agent.list({ location: { directory: project } });
    const childAgent = agents.data.find(
      (agent) => agent.mode === "subagent" || (agent.mode === "all" && agent.id !== "build"),
    );
    expect(childAgent).toBeDefined();
    if (!childAgent) throw new Error("Expected a native v2 subagent mode for the fixture");

    parent = await client.createSession(
      {
        provider: "opencode",
        cwd: project,
        model: "fixture/fixture-model",
        title: "Paseo native parent fixture",
        providerOptions: { permission: { task: "allow" } },
      },
      { agentId: "native-v2-parent" },
      { persistSession: false },
    );
    sibling = await client.createSession(
      {
        provider: "opencode",
        cwd: project,
        model: "fixture/fixture-model",
        title: "Paseo unrelated sibling fixture",
      },
      { agentId: "native-v2-unrelated-sibling" },
      { persistSession: false },
    );
    const parentHandle = parent.describePersistence();
    const siblingHandle = sibling.describePersistence();
    if (!parentHandle?.nativeHandle || !siblingHandle?.nativeHandle)
      throw new Error("Expected native v2 parent and sibling persistence handles");

    const parentPrompt = "PASEO_NATIVE_FIXTURE_SPAWN_BACKGROUND_CHILD";
    const childPrompt = "PASEO_NATIVE_FIXTURE_BACKGROUND_CHILD_HOLD";
    const siblingPrompt = "PASEO_NATIVE_FIXTURE_UNRELATED_SIBLING_HOLD";
    model.configureNativeFamily({
      childAgent: childAgent.id,
      childDescription: BACKGROUND_CHILD_TITLE,
      parentPrompt,
      childPrompt,
      siblingPrompt,
    });
    const parentEvents: string[] = [];
    parent.subscribe((event) => parentEvents.push(event.type));
    let parentRunError: string | undefined;
    const parentRun = parent.run(parentPrompt).catch((error: unknown) => {
      parentRunError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return undefined;
    });
    let parentRunSettled = false;
    void parentRun.then(() => {
      parentRunSettled = true;
      return undefined;
    });
    const siblingRun = sibling.run(siblingPrompt).catch(() => undefined);
    let siblingRunSettled = false;
    void siblingRun.then(() => {
      siblingRunSettled = true;
      return undefined;
    });
    await waitFor(
      "the exact V2 SubagentJob tool call",
      () => model.subagentToolCalls(),
      (count) => count === 1,
    );
    let listedChild: Awaited<ReturnType<typeof inspector.client.session.get>> | undefined;
    try {
      listedChild = await waitFor(
        "the persisted native background child created by SubagentJob",
        async () => {
          const page = await inspector!.client.session.list({
            parentID: parentHandle.nativeHandle,
            limit: 10,
          });
          return page.data.find(
            (candidate) =>
              candidate.parentID === parentHandle.nativeHandle &&
              candidate.title === BACKGROUND_CHILD_TITLE,
          );
        },
        (candidate) => candidate !== undefined,
      );
    } catch (error) {
      const sessions = await inspector.client.session.list({ limit: 100 });
      const summary = sessions.data.map((session) => ({
        id: session.id,
        parentID: session.parentID,
        title: session.title,
        outcome: session.outcome,
      }));
      const parentLog = await sessionLogSummary(inspector.client, parentHandle.nativeHandle);
      const pendingPermissions = await inspector.client.permission.list({
        sessionID: parentHandle.nativeHandle,
      });
      throw new Error(
        `${String(error)}; parentRunError=${parentRunError}; parentEvents=${JSON.stringify(parentEvents)}; model=${JSON.stringify(model.familyRequestSummary())}; sessions=${JSON.stringify(summary)}; pendingPermissions=${JSON.stringify(pendingPermissions)}; parentLog=${JSON.stringify(parentLog)}`,
        { cause: error },
      );
    }
    expect(listedChild?.parentID).toBe(parentHandle.nativeHandle);
    if (!listedChild) throw new Error("Expected the exact native child created by SubagentJob");
    await waitFor(
      "parent, background child, and unrelated sibling model completions to remain active",
      () => model.heldCompletions(),
      (count) => count >= 3,
    );
    const activeBeforeStop = await inspector.client.session.active();
    expect(activeBeforeStop[parentHandle.nativeHandle]).toBeDefined();
    expect(activeBeforeStop[listedChild.id]).toBeDefined();
    expect(activeBeforeStop[siblingHandle.nativeHandle]).toBeDefined();
    // V2.2.5 can expose a known background child through `active` before a
    // durable execution-start event reaches its log. The held child model
    // response plus this exact-ID activity check prove it is active here;
    // durable interrupted terminals are required after the stop below.

    // This is a fixture stimulus, not an archive action: create one exact
    // queued user input while the parent is held so the stop implementation
    // has to discard it through `inbox.cancel`, without prompting or
    // resuming it. The real child-cancellation callback can add another
    // pending item during the native interrupt as well.
    const queuedInputText = "PASEO_NATIVE_FIXTURE_PENDING_INPUT_MUST_BE_CANCELLED";
    const queuedInput = await inspector.client.session.prompt({
      sessionID: parentHandle.nativeHandle,
      text: queuedInputText,
      delivery: "queue",
      resume: false,
    });
    const parentInboxBeforeStop = await waitFor(
      "the exact queued parent input before native archive stop",
      () => inspector!.client.session.inbox.list({ sessionID: parentHandle.nativeHandle }),
      (inbox) => inbox.some((item) => item.id === queuedInput.id),
    );
    expect(parentInboxBeforeStop.some((item) => item.id === queuedInput.id)).toBe(true);
    const [parentInfoBeforeStop, childInfoBeforeStop, parentLogBeforeStop, childLogBeforeStop] =
      await Promise.all([
        inspector.client.session.get({ sessionID: parentHandle.nativeHandle }),
        inspector.client.session.get({ sessionID: listedChild.id }),
        sessionLogSummary(inspector.client, parentHandle.nativeHandle),
        sessionLogSummary(inspector.client, listedChild.id),
      ]);
    const parentTimingBeforeStop = nativeSessionTiming(parentInfoBeforeStop);
    const childTimingBeforeStop = nativeSessionTiming(childInfoBeforeStop);
    expect(parentTimingBeforeStop.time.busy).toEqual(expect.any(Number));
    expect(childTimingBeforeStop.time.busy).toEqual(expect.any(Number));
    const completionRequestsBeforeStop = model.completionRequests();

    const nativeStop = await client.stopNativeSession(parentHandle);
    if (nativeStop.status !== "settled") {
      // Read only the already-proven parent/child pair. This is diagnostic
      // evidence for pending-input semantics, not an inventory scan or a
      // reason to prompt, resume, or drain either session.
      const [parentInbox, childInbox, active] = await Promise.all([
        inspector.client.session.inbox.list({ sessionID: parentHandle.nativeHandle }),
        inspector.client.session.inbox.list({ sessionID: listedChild.id }),
        inspector.client.session.active(),
      ]);
      throw new Error(
        `native family stop did not settle: ${JSON.stringify({
          nativeStop,
          cancelledInboxIds,
          parentTimingBeforeStop,
          childTimingBeforeStop,
          parentInbox,
          childInbox,
          active: {
            parent: Boolean(active[parentHandle.nativeHandle]),
            child: Boolean(active[listedChild.id]),
            sibling: Boolean(active[siblingHandle.nativeHandle]),
          },
        })}`,
      );
    }
    // Native settlement must be proved before fixture transport cleanup. The
    // sibling is already-known only for this assertion; it never becomes a
    // target for family traversal.
    const activeAfterStop = await inspector.client.session.active();
    expect(activeAfterStop[parentHandle.nativeHandle]).toBeUndefined();
    expect(activeAfterStop[listedChild.id]).toBeUndefined();
    expect(activeAfterStop[siblingHandle.nativeHandle]).toBeDefined();
    const [
      parentInboxAfterStop,
      childInboxAfterStop,
      parentInfoAfterStop,
      childInfoAfterStop,
      parentLogAfterStop,
      childLogAfterStop,
    ] = await Promise.all([
      inspector.client.session.inbox.list({ sessionID: parentHandle.nativeHandle }),
      inspector.client.session.inbox.list({ sessionID: listedChild.id }),
      inspector.client.session.get({ sessionID: parentHandle.nativeHandle }),
      inspector.client.session.get({ sessionID: listedChild.id }),
      sessionLogSummary(inspector.client, parentHandle.nativeHandle),
      sessionLogSummary(inspector.client, listedChild.id),
    ]);
    const parentTimingAfterStop = nativeSessionTiming(parentInfoAfterStop);
    const childTimingAfterStop = nativeSessionTiming(childInfoAfterStop);
    expectFreshInterruptedOutcome(parentTimingBeforeStop, parentTimingAfterStop);
    expectFreshInterruptedOutcome(childTimingBeforeStop, childTimingAfterStop);
    expect(parentInboxAfterStop).toEqual([]);
    expect(childInboxAfterStop).toEqual([]);
    expect(cancelledInboxIds).toContainEqual({
      sessionID: parentHandle.nativeHandle,
      inboxID: queuedInput.id,
    });
    // The default v2 server persists SessionInfo time/outcome but projects
    // only `log.synced` through session.log. The cancellation's durable ID
    // is the inbox item, not a replayable payload/event on this endpoint.
    expect(model.completionRequests()).toBe(completionRequestsBeforeStop);
    console.info(
      `[opencode-v2-native-fixture] ${JSON.stringify({
        parentTimingBeforeStop,
        childTimingBeforeStop,
        parentTimingAfterStop,
        childTimingAfterStop,
        parentLogBeforeStop,
        childLogBeforeStop,
        parentLogAfterStop,
        childLogAfterStop,
        cancelledInboxIds,
        completionRequestsBeforeStop,
        completionRequestsAfterStop: model.completionRequests(),
        siblingStillActive: Boolean(activeAfterStop[siblingHandle.nativeHandle]),
      })}`,
    );

    // v2.2.5 can leave the upstream model HTTP response open after its
    // durable interruption. Record the resident observer state before the
    // fixture closes that transport; it is not part of stop acceptance.
    await delay(250);
    console.info(
      `[opencode-v2-native-fixture] parent observer ${parentRunSettled ? "settled" : "still pending"} before transport cleanup`,
    );

    // Complete only the sibling. Its active state above proves parent-family
    // stop did not cancel it; its normal terminal confirms it remained usable.
    model.finishHeldCompletion("sibling");
    await waitFor("the unrelated sibling to complete", () => siblingRunSettled, Boolean);
    await siblingRun;
    expect((await inspector.client.session.active())[siblingHandle.nativeHandle]).toBeUndefined();
    const siblingInfo = await inspector.client.session.get({
      sessionID: siblingHandle.nativeHandle,
    });
    expect(siblingInfo.parentID).toBeUndefined();
    expect(siblingInfo.outcome).toBe("succeeded");
  } finally {
    model.abortHeldCompletions();
    await model.close();
    await inspector?.release();
    await sibling?.close();
    await parent?.close();
    await idle?.close();
    await settled?.close();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
