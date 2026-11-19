import { OpenCodeV2Session } from "./session.js";
import { OpenCodeHistorySession } from "../history-session.js";
import { messages } from "./history.js";
import { V2Timeline } from "./timeline.js";
import { V2_CAPABILITIES } from "./capabilities.js";
import {
  controls,
  permissionRules,
  applyResumeOverrides,
  requiresDedicatedV2Server,
} from "./configuration.js";
import { commands } from "./commands.js";

import { waitForLocationReady } from "./readiness.js";

import type { SessionInfo } from "@opencode/client";

import type { Logger } from "pino";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentDraftControls,
  AgentLaunchContext,
  NativeSessionStopOptions,
  NativeSessionStopResult,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
  ImportableProviderSession,
  ImportProviderSessionInput,
  ImportProviderSessionContext,
  ListImportableSessionsOptions,
  ProviderRefreshContext,
} from "../../../agent-sdk-types.js";
import {
  createProviderEnv,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";

import { importSessionFromPersistence } from "../../../provider-session-import.js";

import type { OpenCodeBridge } from "../bridge.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { V2Runtime, type V2Connection } from "./runtime.js";
import type { OpenCodeServiceSelection } from "./service-selection.js";
import { modelRef, modesFromV2, modelsFromV2 } from "./mapping.js";
import { hasOpenCodeV2ExcludedFamilyMember, stopOpenCodeV2NativeSession } from "./native-stop.js";
import { readOpenCodeV2ServiceIdentity } from "./service-identity.js";

interface V2AgentOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  bridge?: OpenCodeBridge;
  runtime?: Pick<V2Runtime, "acquire" | "shutdown"> &
    Partial<Pick<V2Runtime, "getServiceIdentity">>;
  selection?: OpenCodeServiceSelection;
}

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode";
  readonly capabilities: AgentCapabilityFlags;
  private readonly runtime: Pick<V2Runtime, "acquire" | "shutdown"> &
    Partial<Pick<V2Runtime, "getServiceIdentity">>;
  private readonly connections = new Map<string, V2Connection>();
  // A stored-only stop can discover that releasing the helper it just acquired
  // would terminate an excluded native branch. Keep that lease until a later
  // proven stop can release it safely; it is not a session that may resume.
  private readonly protectedNativeStopConnections = new Map<string, V2Connection>();
  private readonly nativeStopTails = new Map<string, Promise<NativeSessionStopResult>>();
  constructor(private readonly options: V2AgentOptions) {
    const bridge = options.bridge;
    this.capabilities = { ...V2_CAPABILITIES, supportsNativePaseoTools: Boolean(bridge) };
    this.runtime =
      options.runtime ??
      new V2Runtime({
        ...options,
      });
  }
  async isAvailable() {
    return true;
  }
  async shutdown() {
    this.protectedNativeStopConnections.clear();
    await this.runtime.shutdown();
  }
  canStopPersistedNativeSession(handle: AgentPersistenceHandle): boolean {
    return (
      handle.provider === this.provider &&
      typeof handle.nativeHandle === "string" &&
      handle.nativeHandle.length > 0 &&
      readOpenCodeV2ServiceIdentity(handle.metadata) !== null
    );
  }
  async stopNativeSession(
    handle: AgentPersistenceHandle,
    options: NativeSessionStopOptions = {},
  ): Promise<NativeSessionStopResult> {
    const nativeHandle = handle.provider === this.provider ? handle.nativeHandle : undefined;
    if (!nativeHandle) return { status: "unavailable" };
    const excludedNativeHandles = [...new Set(options.excludedNativeHandles ?? [])].sort();
    const operationKey = [nativeHandle, ...excludedNativeHandles].join("\u0000");
    const existing = this.nativeStopTails.get(operationKey);
    if (existing) return existing;
    let operation!: Promise<NativeSessionStopResult>;
    operation = this.stopNativeSessionNow(nativeHandle, handle, { excludedNativeHandles }).finally(
      () => {
        if (this.nativeStopTails.get(operationKey) === operation)
          this.nativeStopTails.delete(operationKey);
      },
    );
    this.nativeStopTails.set(operationKey, operation);
    return operation;
  }
  // eslint-disable-next-line complexity -- Each branch preserves a distinct ownership/release proof.
  private async stopNativeSessionNow(
    nativeHandle: string,
    handle: AgentPersistenceHandle,
    options: NativeSessionStopOptions,
  ): Promise<NativeSessionStopResult> {
    let connection: V2Connection | undefined;
    try {
      const liveResident = this.connections.get(nativeHandle);
      const recoveryLease = this.protectedNativeStopConnections.get(nativeHandle);
      const resident = liveResident ?? recoveryLease;
      const storedServiceIdentity = readOpenCodeV2ServiceIdentity(handle.metadata);
      // A resident connection was attached to this exact native handle. It is
      // stronger evidence than legacy persistence that lacked a service token.
      if (!resident && !storedServiceIdentity) return { status: "unavailable" };
      // A recovery lease is held only to prevent the helper from stopping an
      // excluded branch after a previous stored-only refusal. Retaining it for
      // this retry would make `users > 1`, but that second lease is this same
      // operation rather than independent proof that releasing both leases is
      // safe. Keep refusing while exclusions remain; a later retry with no
      // protected handles can settle and release both leases normally.
      if (!liveResident && recoveryLease && options.excludedNativeHandles?.length)
        return { status: "unavailable" };
      if (resident && (await this.hasUnprovenExcludedFamily(resident, nativeHandle, options)))
        return { status: "unavailable" };
      if (!resident) {
        // Never start or attach an owned helper merely to discover that a
        // stored-only handle belongs to another service. The runtime derives
        // this identity from its effective service/data-home configuration.
        const currentServiceIdentity = await this.runtime.getServiceIdentity?.();
        if (!currentServiceIdentity || currentServiceIdentity !== storedServiceIdentity)
          return { status: "unavailable" };
      }
      connection = resident?.retain() ?? (await this.runtime.acquire());
      if (!resident && connection.serviceIdentity !== storedServiceIdentity)
        return { status: "unavailable" };
      // A stored-only stop has just acquired the only lease to an owned,
      // dedicated helper. Manager exclusions intentionally include every
      // out-of-cascade native handle because provider IDs do not establish a
      // service boundary. Even when none is currently a descendant of the
      // target, releasing this helper could terminate one of those protected
      // sessions. Retain the lease and leave the archive recoverable rather
      // than using global inventory as cancellation authority or disrupting
      // an excluded sibling.
      if (
        !resident &&
        options.excludedNativeHandles?.length &&
        connection.canReleaseWithoutStoppingService?.() !== true
      ) {
        this.protectedNativeStopConnections.set(nativeHandle, connection);
        connection = undefined;
        return { status: "unavailable" };
      }
      if (!resident && (await this.hasUnprovenExcludedFamily(connection, nativeHandle, options))) {
        // Do not interrupt a root when an excluded descendant is present (or
        // cannot be ruled out): a foreground native child inherits its parent
        // interrupt. If this is the only owned-helper lease, retain it rather
        // than releasing the helper and indirectly stopping that child.
        if (connection.canReleaseWithoutStoppingService?.() !== true) {
          this.protectedNativeStopConnections.set(nativeHandle, connection);
          connection = undefined;
        }
        return { status: "unavailable" };
      }
      const result = await stopOpenCodeV2NativeSession(connection.client, nativeHandle, options);
      // Another lease can disappear while the native operation is awaiting a
      // late family reconciliation. Re-check before `finally` releases this
      // acquired lease: a now-sole dedicated helper must not become an
      // indirect stop for an excluded session, even if this target itself
      // reached a terminal result.
      if (
        !resident &&
        options.excludedNativeHandles?.length &&
        connection.canReleaseWithoutStoppingService?.() !== true
      ) {
        this.protectedNativeStopConnections.set(nativeHandle, connection);
        connection = undefined;
        return { status: "unavailable" };
      }
      if (result.status === "settled")
        await this.releaseProtectedNativeStopConnection(nativeHandle);
      return result;
    } catch (error) {
      return { status: "uncertain", error: error instanceof Error ? error.message : String(error) };
    } finally {
      await connection?.release();
    }
  }
  private async hasUnprovenExcludedFamily(
    connection: V2Connection,
    nativeHandle: string,
    options: NativeSessionStopOptions,
  ): Promise<boolean> {
    if (!options.excludedNativeHandles?.length) return false;
    const excludedMember = await hasOpenCodeV2ExcludedFamilyMember(
      connection.client,
      nativeHandle,
      options.excludedNativeHandles,
    );
    return excludedMember !== "absent";
  }
  private async releaseProtectedNativeStopConnection(nativeHandle: string): Promise<void> {
    const connection = this.protectedNativeStopConnections.get(nativeHandle);
    if (!connection) return;
    this.protectedNativeStopConnections.delete(nativeHandle);
    await connection.release();
  }
  async fetchCatalog(options: FetchCatalogOptions, context?: ProviderRefreshContext) {
    const connection = await this.runtime.acquire({
      fresh: options.force,
      signal: context?.signal,
    });
    const location = {
      directory: options.scope === "workspace" ? options.cwd : resolveOpenCodeHomeDir(),
    };
    const request = { signal: context?.signal };
    const activity = <T>(name: string, operation: () => Promise<T>) =>
      context ? context.runActivity(name, operation) : operation();
    try {
      await activity("plugin.list", () =>
        waitForLocationReady({ client: connection.client, location, signal: request.signal }),
      );
      if (options.force)
        await activity("paseo.bridge.refresh", () =>
          connection.refreshLocation(location.directory, request.signal),
        );
      const [models, agents, providers] = await Promise.all([
        activity("model.list", () => connection.client.model.list({ location }, request)),
        activity("agent.list", () => connection.client.agent.list({ location }, request)),
        activity("provider.list", () => connection.client.provider.list({ location }, request)),
      ]);
      if (!providers.data.length)
        throw new Error(
          "OpenCode has no connected providers. Authenticate using opencode auth login.",
        );
      return { models: modelsFromV2(models.data), modes: modesFromV2(agents.data) };
    } finally {
      await connection.release();
    }
  }
  async createSession(
    config: AgentSessionConfig,
    launch?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const connection = await this.runtime.acquire(
      requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
    );
    try {
      const info = await connection.client.session.create({
        location: { directory: config.cwd },
        title: config.title,
        agent: config.modeId ?? "build",
        model: config.model ? modelRef(config.model, config.thinkingOptionId) : undefined,
        permissions: permissionRules(config),
      });
      return await this.attach(connection, info, config, launch, options?.persistSession !== false);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const cwd = overrides?.cwd ?? handle.metadata?.cwd;
    if (typeof cwd !== "string")
      throw new Error("OpenCode resume requires the original working directory");
    const config: AgentSessionConfig = {
      ...handle.metadata,
      ...overrides,
      provider: "opencode",
      cwd,
    };
    if (options?.purpose === "history") return this.readHistory(handle, launch);
    const connection =
      this.connections.get(handle.nativeHandle ?? handle.sessionId)?.retain() ??
      (await this.runtime.acquire(
        requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
      ));
    try {
      const info = await connection.client.session.get({
        sessionID: handle.nativeHandle ?? handle.sessionId,
      });
      await applyResumeOverrides(connection.client, info, overrides);
      return await this.attach(connection, info, config, launch, true);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  private async readHistory(
    handle: AgentPersistenceHandle,
    launch?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const connection =
      this.connections.get(handle.nativeHandle ?? handle.sessionId)?.retain() ??
      (await this.runtime.acquire({ purpose: "history", env: launch?.env }));
    try {
      const info = await connection.client.session.get({
        sessionID: handle.nativeHandle ?? handle.sessionId,
      });
      const history: AgentStreamEvent[] = [];
      await new V2Timeline(false).messages(await messages(connection.client, info.id), (event) => {
        history.push(event);
      });
      return new OpenCodeHistorySession(
        handle,
        this.capabilities,
        {
          provider: "opencode",
          sessionId: info.id,
          model: info.model ? `${info.model.providerID}/${info.model.id}` : null,
          modeId: info.agent ?? null,
          thinkingOptionId: info.model?.variant ?? null,
        },
        history,
      );
    } finally {
      await connection.release();
    }
  }
  private async attach(
    connection: V2Connection,
    info: SessionInfo,
    config: AgentSessionConfig,
    launch: AgentLaunchContext | undefined,
    persist: boolean,
  ) {
    const acquire = () =>
      this.runtime.acquire(
        requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
      );
    let ownedConnection = connection;
    const bridge = this.options.bridge;
    const unbind = bridge?.bindSession({
      sessionId: info.id,
      env: launch?.env ?? {},
      tools: launch?.paseoTools,
    });
    const bound = new Map<string, () => void>();
    const bindChild = (childId: string) => {
      this.connections.set(childId, ownedConnection);
      if (bound.has(childId)) return;
      const childUnbind = bridge?.bindSession({
        sessionId: childId,
        env: launch?.env ?? {},
        tools: launch?.paseoTools,
      });
      if (childUnbind) bound.set(childId, childUnbind);
    };
    this.connections.set(info.id, connection);
    const releaseBindings = () => {
      unbind?.();
      for (const cleanup of bound.values()) cleanup();
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.delete(id);
    };
    const moved = (next: V2Connection) => {
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.set(id, next);
      ownedConnection = next;
    };
    const session = new OpenCodeV2Session(
      connection,
      connection.serviceIdentity,
      info,
      config,
      this.options.logger,
      persist,
      Boolean(this.options.bridge),
      releaseBindings,
      bindChild,
      acquire,
      moved,
    );
    try {
      await session.initialize(
        launch?.env
          ? createProviderEnv({ runtimeSettings: this.options.settings, overlays: [launch.env] })
          : undefined,
      );
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async listControls(config: AgentSessionConfig): Promise<AgentDraftControls> {
    return { controls, options: config.providerOptions ?? {} };
  }
  async listCommands(config: AgentSessionConfig) {
    const connection = await this.runtime.acquire();
    try {
      return await commands(connection.client, config.cwd);
    } finally {
      await connection.release();
    }
  }
  async listImportableSessions(
    options: ListImportableSessionsOptions = {},
  ): Promise<ImportableProviderSession[]> {
    const connection = await this.runtime.acquire();
    try {
      const sessions: SessionInfo[] = [];
      let cursor: string | undefined;
      const scanLimit = Math.min(options.scanLimit ?? 100, 500);
      do {
        const page = await connection.client.session.list({
          ...(cursor ? { cursor } : { directory: options.cwd, search: options.query }),
          limit: Math.min(50, scanLimit - sessions.length),
        });
        sessions.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor && sessions.length < scanLimit);
      return sessions
        .filter((info) => !info.parentID && !info.time.archived)
        .slice(0, options.limit ?? 50)
        .map((info) => ({
          providerHandleId: info.id,
          cwd: info.location.directory,
          title: info.title ?? null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          lastActivityAt: new Date(info.time.updated),
        }));
    } finally {
      await connection.release();
    }
  }
  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const connection = await this.runtime.acquire();
    try {
      const info = await connection.client.session.get({ sessionID: input.providerHandleId });
      return await importSessionFromPersistence({
        provider: "opencode",
        request: input,
        context,
        resumeSession: this.resumeSession.bind(this),
        config: {
          title: info.title,
          modeId: info.agent,
          model: info.model ? `${info.model.providerID}/${info.model.id}` : undefined,
        },
      });
    } finally {
      await connection.release();
    }
  }
}
