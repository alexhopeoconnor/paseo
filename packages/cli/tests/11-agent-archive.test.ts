#!/usr/bin/env npx tsx

/**
 * Phase 11: Agent Archive Command Tests
 *
 * Tests the agent archive command - archiving (soft-delete) agents.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent archive --help shows options
 * - agent archive requires ID argument
 * - agent archive handles daemon not running
 * - agent archive --force flag is accepted
 * - agent archive is idempotent for a completed archive
 * - agent archive retries an archived parent's outstanding child cascade
 * - agent archive reports daemon failure and leaves a partial cascade visible
 * - agent archive reports a partial child cascade as a failure, not success
 */

import assert from "node:assert";
import { getAvailablePort } from "./helpers/network.ts";
import { createTempDirs, runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";
import { $ } from "zx";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

$.verbose = false;

const TARGET_AGENT_ID = "11111111-2222-4333-8444-555555555555";

/**
 * A PASEO_HOME whose archive-inclusive agent listing overflows one page.
 * `fetch_agents` answers at most 200 entries, so the older unarchived agent
 * sits behind 201 newer archived ones and never appears on the first page.
 */
async function seedHomePastPageCap(
  targetAgentId: string,
  newerAgentCount = 201,
): Promise<{ paseoHome: string; workDir: string }> {
  const dirs = await createTempDirs();
  const olderAt = "2026-09-03T18:29:21.949Z";
  const newerAt = "2026-09-10T12:00:00.000Z";

  const writeRecord = (record: Record<string, unknown>) =>
    writeFile(
      join(dirs.paseoHome, "agents", `${record.id as string}.json`),
      JSON.stringify(record, null, 2),
    );

  await writeRecord({
    id: targetAgentId,
    provider: "codex",
    cwd: dirs.workDir,
    createdAt: olderAt,
    updatedAt: olderAt,
    title: "finished agent",
    labels: {},
    lastStatus: "closed",
    requiresAttention: true,
    attentionReason: "finished",
  });

  await Promise.all(
    Array.from({ length: newerAgentCount }, (_unused, index) =>
      writeRecord({
        id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
        provider: "codex",
        cwd: dirs.workDir,
        createdAt: newerAt,
        updatedAt: newerAt,
        title: `archived ${index}`,
        labels: {},
        lastStatus: "closed",
        archivedAt: newerAt,
      }),
    ),
  );

  return dirs;
}

interface SeedAgentRecord {
  id: string;
  labels?: Record<string, string>;
  archivedAt?: string;
  lastStatus?: string;
  persistence?: Record<string, unknown>;
}

async function seedAgentRecords(
  records: SeedAgentRecord[],
): Promise<{ paseoHome: string; workDir: string }> {
  const dirs = await createTempDirs();
  const timestamp = "2026-09-03T18:29:21.949Z";

  await Promise.all(
    records.map((record) =>
      writeFile(
        join(dirs.paseoHome, "agents", `${record.id}.json`),
        JSON.stringify(
          {
            provider: "codex",
            cwd: dirs.workDir,
            createdAt: timestamp,
            updatedAt: timestamp,
            title: `agent ${record.id.slice(0, 7)}`,
            labels: {},
            lastStatus: "closed",
            ...record,
          },
          null,
          2,
        ),
      ),
    ),
  );

  return dirs;
}

function pendingNativeStop(
  operation: "archive" | "terminate",
  sessionId: string,
): Record<string, unknown> {
  const nativeHandle = `${sessionId}-native-handle`;
  return {
    provider: "codex",
    sessionId,
    nativeHandle,
    metadata: {
      paseoArchiveStopPending: {
        version: 1,
        operation,
        provider: "codex",
        sessionId,
        nativeHandle,
        requestedAt: "2026-09-03T18:29:21.949Z",
      },
    },
  };
}

/** The CLI writes its JSON error to stderr, after any Node warnings. */
function parseJsonError(stderr: string): unknown {
  const start = stderr.indexOf("{");
  assert(start >= 0, `expected a JSON error, got: ${stderr}`);
  return JSON.parse(stderr.slice(start));
}

console.log("=== Agent Archive Command Tests ===\n");

// Allocate an unused endpoint for connection-error and argument-validation checks.
const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));

try {
  // Test 1: agent archive --help shows options
  {
    console.log("Test 1: agent archive --help shows options");
    const result = await $`npx paseo agent archive --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "agent archive --help should exit 0");
    assert(result.stdout.includes("--force"), "help should mention --force flag");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("<id>"), "help should mention required id argument");
    console.log("✓ agent archive --help shows options\n");
  }

  // Test 2: agent archive requires ID argument
  {
    console.log("Test 2: agent archive requires ID argument");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without id");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument");
    assert(hasError, "error should mention missing argument");
    console.log("✓ agent archive requires ID argument\n");
  }

  // Test 3: agent archive handles daemon not running
  {
    console.log("Test 3: agent archive handles daemon not running");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive abc123`.nothrow();
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ agent archive handles daemon not running\n");
  }

  // Test 4: agent archive --force flag is accepted
  {
    console.log("Test 4: agent archive --force flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive abc123 --force`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --force flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ agent archive --force flag is accepted\n");
  }

  // Test 5: agent archive with ID and --host flag is accepted
  {
    console.log("Test 5: agent archive with ID and --host flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive abc123 --host localhost:${port}`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ agent archive with ID and --host flag is accepted\n");
  }

  // Test 6: agent shows archive in subcommands
  {
    console.log("Test 6: agent --help shows archive subcommand");
    const result = await $`npx paseo agent --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "agent --help should exit 0");
    assert(result.stdout.includes("archive"), "help should mention archive subcommand");
    console.log("✓ agent --help shows archive subcommand\n");
  }

  // Test 7: -q (quiet) flag is accepted with agent archive
  {
    console.log("Test 7: -q (quiet) flag is accepted with agent archive");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} -q agent archive abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted with agent archive\n");
  }

  // Test 8: archives an agent that sits past the agent listing page cap
  {
    console.log("Test 8: archives an agent past the agent listing page cap");
    const daemon = await startTestDaemon(await seedHomePastPageCap(TARGET_AGENT_ID));
    const host = `127.0.0.1:${daemon.port}`;
    try {
      const listed = await runPaseoCli(daemon, [
        "agent",
        "ls",
        "--global",
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(listed.exitCode, 0, listed.stderr);
      assert(
        (JSON.parse(listed.stdout) as Array<{ id: string }>).some((a) => a.id === TARGET_AGENT_ID),
        "the agent should be listed before it is archived",
      );

      const detached = await runPaseoCli(daemon, [
        "agent",
        "detach",
        TARGET_AGENT_ID,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(detached.exitCode, 0, detached.stdout + detached.stderr);

      const archived = await runPaseoCli(daemon, [
        "agent",
        "archive",
        TARGET_AGENT_ID,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(archived.exitCode, 0, archived.stdout + archived.stderr);
      const result = JSON.parse(archived.stdout) as {
        agentId: string;
        status: string;
        archivedAt: string;
      };
      assert.strictEqual(result.agentId, TARGET_AGENT_ID);
      assert.strictEqual(result.status, "archived");
      assert.strictEqual(typeof result.archivedAt, "string");

      const remaining = await runPaseoCli(daemon, [
        "agent",
        "ls",
        "--global",
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(remaining.exitCode, 0, remaining.stderr);
      assert(
        !(JSON.parse(remaining.stdout) as Array<{ id: string }>).some(
          (a) => a.id === TARGET_AGENT_ID,
        ),
        "the archived agent should leave the active list",
      );

      const repeated = await runPaseoCli(daemon, [
        "agent",
        "archive",
        TARGET_AGENT_ID,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(repeated.exitCode, 0, repeated.stdout + repeated.stderr);
      const repeatedResult = JSON.parse(repeated.stdout) as {
        agentId: string;
        status: string;
        archivedAt: string;
      };
      assert.deepStrictEqual(repeatedResult, {
        agentId: TARGET_AGENT_ID,
        status: "archived",
        archivedAt: result.archivedAt,
      });

      const missing = await runPaseoCli(daemon, [
        "agent",
        "archive",
        "no-such-agent",
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(missing.exitCode, 1);
      assert.deepStrictEqual(parseJsonError(missing.stderr), {
        error: {
          code: "AGENT_NOT_FOUND",
          message: "Agent not found: no-such-agent",
          details: 'Use "paseo ls" to list available agents',
        },
      });
    } finally {
      await daemon.stop();
    }
    console.log("✓ archives an agent past the agent listing page cap\n");
  }
  // Keep archive's existing case-insensitive and unique partial-name inputs working.
  for (const query of ["FINISHED AGENT", "nished age", "ABCDEFAB"]) {
    console.log(`Test 9: archives by existing identifier form: ${query}`);
    const targetId = "abcdefab-2222-4333-8444-555555555555";
    const daemon = await startTestDaemon(await seedHomePastPageCap(targetId, 0));
    try {
      const archived = await runPaseoCli(daemon, [
        "agent",
        "archive",
        query,
        "--json",
        "--host",
        `127.0.0.1:${daemon.port}`,
      ]);
      assert.strictEqual(archived.exitCode, 0, archived.stdout + archived.stderr);
      const result = JSON.parse(archived.stdout) as { agentId: string; status: string };
      assert.strictEqual(result.agentId, targetId);
      assert.strictEqual(result.status, "archived");
    } finally {
      await daemon.stop();
    }
  }
  // Test 10: archives an agent whose workspace no longer exists (omitted from agent ls)
  {
    console.log("Test 10: archives an agent whose workspace was deleted");
    const orphanId = "9eac296c-4d60-4189-a0b5-ae71dd9c6ad9";
    const dirs = await createTempDirs();
    await writeFile(
      join(dirs.paseoHome, "agents", `${orphanId}.json`),
      JSON.stringify(
        {
          id: orphanId,
          provider: "codex",
          cwd: dirs.workDir,
          workspaceId: "deleted-workspace-id",
          createdAt: "2026-09-03T18:29:21.949Z",
          updatedAt: "2026-09-03T18:29:21.949Z",
          title: "orphaned agent",
          labels: {},
          lastStatus: "closed",
        },
        null,
        2,
      ),
    );
    const daemon = await startTestDaemon(dirs);
    const host = `127.0.0.1:${daemon.port}`;
    try {
      const listed = await runPaseoCli(daemon, ["agent", "ls", "-ag", "--json", "--host", host]);
      assert.strictEqual(listed.exitCode, 0, listed.stderr);
      assert.deepStrictEqual(JSON.parse(listed.stdout), []);

      const inspected = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        orphanId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
      assert.strictEqual((JSON.parse(inspected.stdout) as { Archived: boolean }).Archived, false);

      const detached = await runPaseoCli(daemon, [
        "agent",
        "detach",
        orphanId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(detached.exitCode, 0, detached.stdout + detached.stderr);
      assert.deepStrictEqual(JSON.parse(detached.stdout), {
        agentId: orphanId,
        status: "detached",
      });

      const reloaded = await runPaseoCli(daemon, [
        "agent",
        "reload",
        orphanId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(reloaded.exitCode, 1);
      assert.strictEqual(
        (parseJsonError(reloaded.stderr) as { error: { code: string } }).error.code,
        "agent_refresh_failed",
      );

      const archived = await runPaseoCli(daemon, [
        "agent",
        "archive",
        orphanId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(archived.exitCode, 0, archived.stdout + archived.stderr);
      const result = JSON.parse(archived.stdout) as { agentId: string; status: string };
      assert.strictEqual(result.agentId, orphanId);
      assert.strictEqual(result.status, "archived");
    } finally {
      await daemon.stop();
    }
    console.log("✓ archives an agent whose workspace was deleted\n");
  }
  // Test 11: archives an agent whose provider is not available
  {
    console.log("Test 11: archives an agent whose provider is not available");
    const agentId = "22222222-2222-4333-8444-555555555555";
    const dirs = await createTempDirs();
    await writeFile(
      join(dirs.paseoHome, "agents", `${agentId}.json`),
      JSON.stringify(
        {
          id: agentId,
          provider: "not-a-registered-provider",
          cwd: dirs.workDir,
          createdAt: "2026-09-03T18:29:21.949Z",
          updatedAt: "2026-09-03T18:29:21.949Z",
          title: "provider gone",
          labels: {},
          lastStatus: "closed",
        },
        null,
        2,
      ),
    );
    const daemon = await startTestDaemon(dirs);
    const host = `127.0.0.1:${daemon.port}`;
    try {
      const archived = await runPaseoCli(daemon, [
        "agent",
        "archive",
        agentId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(archived.exitCode, 0, archived.stdout + archived.stderr);
      assert.strictEqual((JSON.parse(archived.stdout) as { agentId: string }).agentId, agentId);
    } finally {
      await daemon.stop();
    }
    console.log("✓ archives an agent whose provider is not available\n");
  }
  // Test 12: a missing full ID never resolves to an unlisted agent titled with it
  {
    console.log("Test 12: a missing full ID does not archive an agent titled with it");
    const missingId = "9eac296c-4d60-4189-a0b5-ae71dd9c6ad9";
    const titledId = "c9a97e5d-4a92-4646-a016-53032146d0a1";
    const dirs = await createTempDirs();
    await writeFile(
      join(dirs.paseoHome, "agents", `${titledId}.json`),
      JSON.stringify(
        {
          id: titledId,
          provider: "codex",
          cwd: dirs.workDir,
          workspaceId: "deleted-workspace-id",
          createdAt: "2026-09-03T18:29:21.949Z",
          updatedAt: "2026-09-03T18:29:21.949Z",
          title: missingId,
          labels: {},
          lastStatus: "closed",
        },
        null,
        2,
      ),
    );
    const daemon = await startTestDaemon(dirs);
    const host = `127.0.0.1:${daemon.port}`;
    try {
      for (const command of ["archive", "detach", "reload"]) {
        const result = await runPaseoCli(daemon, [
          "agent",
          command,
          missingId,
          "--json",
          "--host",
          host,
        ]);
        assert.strictEqual(result.exitCode, 1, `${command}: ${result.stdout}`);
        assert.strictEqual(
          (parseJsonError(result.stderr) as { error: { code: string } }).error.code,
          "AGENT_NOT_FOUND",
          `${command}: ${result.stderr}`,
        );
      }

      const titled = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        titledId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(titled.exitCode, 0, titled.stderr);
      assert.strictEqual((JSON.parse(titled.stdout) as { Archived: boolean }).Archived, false);
    } finally {
      await daemon.stop();
    }
    console.log("✓ a missing full ID does not archive an agent titled with it\n");
  }
  // An archived parent can have committed before one child refused to settle.
  // Retrying archive must reach the daemon so the stored parent replays that
  // outstanding cascade instead of being refused locally as already archived.
  {
    console.log("Test 13: archived parent retries its outstanding child cascade");
    const parentId = "cccccccc-1111-4111-8111-111111111111";
    const childId = "dddddddd-2222-4222-8222-222222222222";
    const parentArchivedAt = "2026-09-03T18:29:21.949Z";
    const daemon = await startTestDaemon(
      await seedAgentRecords([
        { id: parentId, archivedAt: parentArchivedAt },
        { id: childId, labels: { "paseo.parent-agent-id": parentId } },
      ]),
    );
    const host = `127.0.0.1:${daemon.port}`;
    try {
      const retried = await runPaseoCli(daemon, [
        "agent",
        "archive",
        parentId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(retried.exitCode, 0, retried.stdout + retried.stderr);
      assert.deepStrictEqual(JSON.parse(retried.stdout), {
        agentId: parentId,
        status: "archived",
        archivedAt: parentArchivedAt,
      });

      const childInspect = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        childId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(childInspect.exitCode, 0, childInspect.stdout + childInspect.stderr);
      const child = JSON.parse(childInspect.stdout) as {
        Archived: boolean;
        ArchivedAt: string | null;
      };
      assert.strictEqual(child.Archived, true);
      assert.strictEqual(typeof child.ArchivedAt, "string");
    } finally {
      await daemon.stop();
    }
    console.log("✓ archived parent retries its outstanding child cascade\n");
  }

  // A failed daemon archive must be reported as a failure with the daemon's
  // reason, not as a local already-archived refusal or an optimistic success.
  {
    console.log("Test 14: daemon archive failure is reported with its reason");
    const parentId = "eeeeeeee-1111-4111-8111-111111111111";
    const childId = "ffffffff-2222-4222-8222-222222222222";
    const parentArchivedAt = "2026-09-03T18:29:21.949Z";
    const daemon = await startTestDaemon(
      await seedAgentRecords([
        {
          id: parentId,
          archivedAt: parentArchivedAt,
          persistence: pendingNativeStop("terminate", "parent-session"),
        },
        { id: childId, labels: { "paseo.parent-agent-id": parentId } },
      ]),
    );
    const host = `127.0.0.1:${daemon.port}`;
    try {
      const failed = await runPaseoCli(daemon, [
        "agent",
        "archive",
        parentId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(failed.exitCode, 1);
      const failure = parseJsonError(failed.stderr) as {
        error: { code: string; message: string };
      };
      assert.strictEqual(failure.error.code, "ARCHIVE_FAILED");
      assert(
        failure.error.message.includes(
          "an archived record still has unresolved native-stop ownership",
        ),
        `error should carry the daemon reason: ${failure.error.message}`,
      );
      assert(
        failure.error.message.includes(parentId),
        `error should identify the unresolved agent: ${failure.error.message}`,
      );

      const parentInspect = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        parentId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(parentInspect.exitCode, 0, parentInspect.stdout + parentInspect.stderr);
      const parent = JSON.parse(parentInspect.stdout) as {
        Archived: boolean;
        ArchivedAt: string | null;
      };
      assert.strictEqual(parent.Archived, true);
      assert.strictEqual(parent.ArchivedAt, parentArchivedAt);

      const childInspect = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        childId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(childInspect.exitCode, 0, childInspect.stdout + childInspect.stderr);
      const child = JSON.parse(childInspect.stdout) as {
        Archived: boolean;
        ArchivedAt: string | null;
      };
      assert.strictEqual(child.Archived, false);
      assert.strictEqual(child.ArchivedAt, null);
    } finally {
      await daemon.stop();
    }
    console.log("✓ daemon archive failure is reported with its reason\n");
  }

  // One archived child and one unresolved child: the successful child stays
  // archived, the unresolved child stays visible and retryable, and the command
  // exits nonzero rather than reporting a partial cascade as success.
  {
    console.log("Test 15: partial child cascade failure is not reported as success");
    const parentId = "99999999-1111-4111-8111-111111111111";
    const archivedChildId = "88888888-2222-4222-8222-222222222222";
    const blockedChildId = "77777777-3333-4333-8333-333333333333";
    const parentArchivedAt = "2026-09-03T18:29:21.949Z";
    const daemon = await startTestDaemon(
      await seedAgentRecords([
        { id: parentId, archivedAt: parentArchivedAt },
        { id: archivedChildId, labels: { "paseo.parent-agent-id": parentId } },
        {
          id: blockedChildId,
          labels: { "paseo.parent-agent-id": parentId },
          persistence: pendingNativeStop("terminate", "blocked-child-session"),
        },
      ]),
    );
    const host = `127.0.0.1:${daemon.port}`;
    try {
      const failed = await runPaseoCli(daemon, [
        "agent",
        "archive",
        parentId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(failed.exitCode, 1);
      const failure = parseJsonError(failed.stderr) as {
        error: { code: string; message: string };
      };
      assert.strictEqual(failure.error.code, "ARCHIVE_FAILED");
      assert(
        failure.error.message.includes(`Failed to archive one or more children of ${parentId}`),
        `error should name the partial cascade: ${failure.error.message}`,
      );

      const archivedChild = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        archivedChildId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(archivedChild.exitCode, 0, archivedChild.stdout + archivedChild.stderr);
      const archivedResult = JSON.parse(archivedChild.stdout) as {
        Archived: boolean;
        ArchivedAt: string | null;
      };
      assert.strictEqual(archivedResult.Archived, true);
      assert.strictEqual(typeof archivedResult.ArchivedAt, "string");

      const blockedChild = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        blockedChildId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(blockedChild.exitCode, 0, blockedChild.stdout + blockedChild.stderr);
      const blockedResult = JSON.parse(blockedChild.stdout) as {
        Archived: boolean;
        ArchivedAt: string | null;
      };
      assert.strictEqual(blockedResult.Archived, false);
      assert.strictEqual(blockedResult.ArchivedAt, null);
    } finally {
      await daemon.stop();
    }
    console.log("✓ partial child cascade failure is not reported as success\n");
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All agent archive tests passed ===");
