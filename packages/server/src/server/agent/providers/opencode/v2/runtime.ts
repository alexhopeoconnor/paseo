import { decorateOpenCodeV2Env, materializeOpenCodeV2Plugin } from "../bridge.js";
import { resolvePaseoHome } from "../../../../paseo-home.js";
import { OpenCode } from "@opencode/client";
import type { V2Api } from "./api.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { Logger } from "pino";
import type { LaunchWrap } from "../../../../../utils/launch-wrap.js";
import { spawnProcess } from "../../../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../../../utils/tree-kill.js";
import {
  createProviderEnv,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { validateOpenCodeResponse } from "./http-response.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import { resolveExternalOpenCodeServer, type ExternalOpenCodeServer } from "./external-server.js";
import {
  processEnvironmentOverrides,
  selectOpenCodeService,
  type OpenCodeServiceSelection,
} from "./service-selection.js";
import { bridgeBindings, connectSharedService } from "./shared-service.js";
import {
  hasManagedBridge,
  openCodeConfigDirectory,
  provisionLocalBridge,
} from "./bridge-provisioning.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCodeBridge } from "../bridge.js";

export interface V2Connection {
  client: V2Api;
  /** Opaque durable identity for the service behind this connection. */
  readonly serviceIdentity?: string;
  /**
   * Whether releasing this lease leaves another lease or a retained current
   * service behind. Native archive uses this before excluding a branch that
   * would otherwise be killed when a dedicated parent helper exits.
   */
  canReleaseWithoutStoppingService?(): boolean;
  release(): Promise<void>;
  retain(): V2Connection;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
  readonly exited: Promise<Error>;
}
interface Generation {
  client: V2Api;
  users: number;
  /** The service this exact generation serves, derived from its kind and effective environment. */
  readonly serviceIdentity: string;
  stop(): Promise<void>;
  exited: Promise<Error>;
  bindSession(sessionId: string, cwd: string): Promise<void>;
  unbindSession(sessionId: string, cwd: string): Promise<void>;
  refreshLocation(cwd: string, signal?: AbortSignal): Promise<void>;
}
export interface V2RuntimeOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  externalServer?: ExternalOpenCodeServer;
  selection?: OpenCodeServiceSelection;
  bridge?: OpenCodeBridge;
}

/** A server started for one caller alone, behind its wrap and with its launch environment. */
export interface V2DedicatedLaunch {
  wrap: LaunchWrap;
  env: Record<string, string> | undefined;
}

export interface V2RuntimeAcquireOptions {
  /** Transcript reads retain their service until runtime shutdown. */
  purpose?: "history";
  fresh?: boolean;
  signal?: AbortSignal;
  /** Environment overlays for a service started for this caller. */
  env?: Record<string, string>;
  /** Start a server for this caller alone. Other callers never share it. */
  dedicated?: V2DedicatedLaunch;
}

function openCodeServiceIdentity(
  selection: OpenCodeServiceSelection,
  environment: NodeJS.ProcessEnv,
): string {
  const source =
    selection.kind === "owned"
      ? {
          kind: "owned",
          paseoHome: resolvePaseoHome(environment),
          openCodeHome: resolveOpenCodeHomeDir(environment),
          home: environment.HOME ?? homedir(),
          openCodeConfigDirectory: openCodeConfigDirectory(environment),
          xdgDataHome: environment.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
          xdgStateHome: environment.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
        }
      : { kind: "shared", url: selection.server.url.replace(/\/$/, "") };
  return `opencode-v2-service-v1:${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`;
}

// The runtime owns a credential for each subprocess; sessions only receive its authenticated client.
export class V2Runtime {
  private current: Promise<Generation> | null = null;
  private readonly historyServices = new Map<string, Promise<Generation>>();
  private generations = new Set<Generation>();
  private starts = new Set<Promise<Generation>>();
  private closed = false;
  private readonly selection: Promise<OpenCodeServiceSelection>;

  constructor(private readonly options: V2RuntimeOptions) {
    this.selection = options.selection
      ? Promise.resolve(options.selection)
      : selectOpenCodeService({
          explicit:
            options.externalServer ??
            resolveExternalOpenCodeServer({
              ...globalThis.process.env,
              ...options.settings?.env,
            }),
          env: options.settings?.env,
        });
  }

  private effectiveEnvironment(overrides?: Record<string, string>): NodeJS.ProcessEnv {
    return createProviderEnv({
      runtimeSettings: this.options.settings,
      overlays: overrides ? [overrides] : [],
    });
  }

  /**
   * Resolves the exact service identity without opening a socket or launching
   * an owned helper. Stored-only native stop uses this as an admission check.
   */
  async getServiceIdentity(input: Pick<V2RuntimeAcquireOptions, "env"> = {}): Promise<string> {
    const selection = await this.selection;
    return openCodeServiceIdentity(selection, this.effectiveEnvironment(input.env));
  }

  async acquire(input: V2RuntimeAcquireOptions = {}): Promise<V2Connection> {
    if (this.closed) throw new Error("OpenCode runtime is closed");
    input.signal?.throwIfAborted();
    this.assertBridgePort();
    const selection = await raceProviderRefreshAbort(input.signal, this.selection);
    if (selection.kind === "explicit") this.assertExplicitConfiguration();
    const pending = this.selectGeneration(selection, input);
    let generation: Generation;
    try {
      generation = await raceProviderRefreshAbort(input.signal, pending);
    } catch (error) {
      if (this.current === pending) this.current = null;
      for (const [identity, service] of this.historyServices) {
        if (service === pending) this.historyServices.delete(identity);
      }
      if (input.signal?.aborted) {
        void pending
          .then(async (started) => {
            if (started.users !== 0) return undefined;
            this.generations.delete(started);
            await started.stop();
            return undefined;
          })
          .catch((cleanupError: unknown) => {
            this.options.logger.warn(
              { error: String(cleanupError) },
              "OpenCode canceled startup cleanup failed",
            );
          });
      }
      throw error;
    }
    if (!this.generations.has(generation)) {
      if (this.current === pending) this.current = null;
      throw new Error("OpenCode helper server exited");
    }
    const connection = this.lease(generation, pending, generation.serviceIdentity);
    if (input.signal?.aborted || this.closed) {
      await connection.release();
      input.signal?.throwIfAborted();
      throw new Error("OpenCode runtime is closed");
    }
    return connection;
  }

  private selectGeneration(
    selection: OpenCodeServiceSelection,
    input: V2RuntimeAcquireOptions,
  ): Promise<Generation> {
    // A wrapped launch always gets its own helper, so nothing it starts shares a
    // server that runs outside the wrap.
    if (input.dedicated) return this.startTracked(input.dedicated);
    let pending: Promise<Generation>;
    if (input.purpose === "history") {
      const identity = openCodeServiceIdentity(selection, this.effectiveEnvironment(input.env));
      if (identity === openCodeServiceIdentity(selection, this.effectiveEnvironment())) {
        this.current ??= this.startTracked();
        pending = this.current;
      } else {
        // Reads need the saved data home, but apply no session or location
        // configuration. Keep one service per data home so closing a reader
        // cannot terminate another native session hosted by that helper.
        pending = this.historyServices.get(identity) ?? this.startTracked(undefined, input.env);
        this.historyServices.set(identity, pending);
      }
    } else if (selection.kind !== "owned") {
      this.current ??= this.startTracked();
      pending = this.current;
    } else if (input.env) {
      pending = this.startTracked(undefined, input.env);
    } else {
      if (!this.current) this.current = this.startTracked();
      pending = this.current;
    }
    return pending;
  }

  private assertBridgePort(): void {
    const port = this.options.settings?.env?.PASEO_OPENCODE_BRIDGE_PORT;
    if (!port || !this.options.bridge) return;
    const actual = new URL(this.options.bridge.sharedV2Connection().baseUrl).port;
    if (Number(port) !== Number(actual))
      throw new Error("PASEO_OPENCODE_BRIDGE_PORT changed; restart Paseo to apply the bridge port");
  }

  // Discovery skips a service that cannot honor the provider environment; an explicit one cannot be skipped.
  private assertExplicitConfiguration(): void {
    const overrides = processEnvironmentOverrides(this.options.settings?.env);
    if (overrides.length)
      throw new Error(
        `OpenCode provider environment configures the server process and cannot be used with an existing OpenCode server: ${overrides.join(", ")}.`,
      );
  }

  private lease(
    generation: Generation,
    pending: Promise<Generation>,
    serviceIdentity: string,
  ): V2Connection {
    if (this.closed || !this.generations.has(generation))
      throw new Error("OpenCode helper server is no longer running");
    generation.users += 1;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      generation.users -= 1;
      if (generation.users !== 0) return;
      if (this.isRetainedService(pending)) return;
      this.generations.delete(generation);
      await generation.stop();
    };
    return {
      client: generation.client,
      serviceIdentity,
      canReleaseWithoutStoppingService: () =>
        generation.users > 1 || this.isRetainedService(pending),
      release,
      retain: () => this.lease(generation, pending, serviceIdentity),
      bindSession: generation.bindSession,
      unbindSession: generation.unbindSession,
      refreshLocation: generation.refreshLocation,
      exited: generation.exited,
    };
  }

  private isRetainedService(pending: Promise<Generation>): boolean {
    return this.current === pending || [...this.historyServices.values()].includes(pending);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.starts);
    await Promise.all([...this.generations].map((generation) => generation.stop()));
    this.generations.clear();
    this.current = null;
    this.historyServices.clear();
  }

  private startTracked(
    dedicated?: V2DedicatedLaunch,
    env?: Record<string, string>,
  ): Promise<Generation> {
    const pending = this.start(dedicated, env);
    this.starts.add(pending);
    void pending.then(
      (generation) =>
        generation.exited.then(() => {
          if (this.current === pending) this.current = null;
          for (const [identity, service] of this.historyServices) {
            if (service === pending) this.historyServices.delete(identity);
          }
          return undefined;
        }),
      () => undefined,
    );
    void pending.then(
      () => this.starts.delete(pending),
      () => this.starts.delete(pending),
    );
    return pending;
  }

  private async start(
    dedicated: V2DedicatedLaunch | undefined,
    env?: Record<string, string>,
  ): Promise<Generation> {
    const selection = await this.selection;
    if (dedicated && selection.kind === "explicit")
      throw new Error(
        "OpenCode is configured to use an existing server, so Paseo cannot start it behind a launch wrap",
      );
    // A discovered server is only a preference; a wrapped caller gets a server Paseo starts.
    if (selection.kind !== "owned" && !dedicated) {
      const generation: Generation = {
        ...(await connectSharedService(selection, this.options)),
        users: 0,
        serviceIdentity: openCodeServiceIdentity(selection, this.effectiveEnvironment()),
      };
      this.generations.add(generation);
      return generation;
    }

    const { settings, managedProcesses, logger } = this.options;
    const launch = await resolveProviderLaunch({
      commandConfig: settings?.command,
      defaultBinary: "opencode",
    });
    // A dedicated launch supplies both wrap and env; history/session-only
    // callers supply the same overlay as plain env. Both must describe the
    // helper we actually spawn, not just the paths we compute from it.
    const callerEnvironment = dedicated?.env ?? env;
    const effectiveEnvironment = this.effectiveEnvironment(callerEnvironment);
    const cwd = resolveOpenCodeHomeDir(effectiveEnvironment);
    await mkdir(cwd, { recursive: true });
    const password = randomBytes(32).toString("base64url");
    const inheritedConfig = globalThis.process.env.OPENCODE_CONFIG_CONTENT;
    const configured = {
      ...(inheritedConfig ? { OPENCODE_CONFIG_CONTENT: inheritedConfig } : {}),
      ...settings?.env,
      ...callerEnvironment,
    };
    const bridge = this.options.bridge;
    const plugin = bridge
      ? await bridge.materializeV2Plugin()
      : await materializeOpenCodeV2Plugin(resolvePaseoHome(effectiveEnvironment));
    const globalConfig = openCodeConfigDirectory(effectiveEnvironment);
    const managed = await hasManagedBridge(globalConfig);
    if (managed && bridge)
      await provisionLocalBridge({
        configDirectory: globalConfig,
        artifact: path.join(fileURLToPath(plugin), "server.js"),
      });
    const decorated = managed
      ? configured
      : decorateOpenCodeV2Env(configured, plugin, bridge ? {} : { mode: "structured-only" });
    const args = [...launch.args, "serve", "--hostname", "127.0.0.1", "--port", "0"];
    const process = spawnProcess(launch.command, args, {
      cwd,
      detached: globalThis.process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      wrap: dedicated?.wrap,
      ...createProviderEnvSpec({
        runtimeSettings: settings,
        overlays: [{ ...decorated, OPENCODE_PASSWORD: password }],
      }),
    });
    const processAbort = new AbortController();
    const exited = new Promise<Error>((resolve) =>
      process.once("exit", (code) => {
        const error = new Error(`OpenCode helper server exited (${code})`);
        processAbort.abort(error);
        resolve(error);
      }),
    );
    let stopped: Promise<void> | undefined;
    const record =
      process.pid && managedProcesses
        ? managedProcesses
            .record({
              owner: { provider: "opencode", kind: "helper-server" },
              pid: process.pid,
              command: launch.command,
              args,
            })
            .catch((error: unknown) => {
              logger.warn({ error }, "Could not record OpenCode helper process");
              return null;
            })
        : Promise.resolve(null);
    const stop = () => {
      stopped ??= (async () => {
        await terminateWithTreeKill(process, { gracefulTimeoutMs: 5_000, forceTimeoutMs: 1_000 });
        const entry = await record;
        if (entry) await managedProcesses?.remove(entry.id);
      })();
      return stopped;
    };
    const deadline = Date.now() + 30_000;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("OpenCode v2 server startup timed out after 30s")),
          30_000,
        );
        let buffer = "";
        const finish = (result: string | Error) => {
          clearTimeout(timer);
          process.stdout?.off("data", onData);
          process.off("error", onError);
          process.off("exit", onExit);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const onData = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-8192);
          const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)(?:\r?\n)/);
          if (match) finish(match[1]);
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null) =>
          finish(new Error(`OpenCode v2 server exited during startup (${code})`));
        process.stdout?.on("data", onData);
        process.once("error", onError);
        process.once("exit", onExit);
        // Drain stderr without retaining provider output that may contain credentials.
        process.stderr?.on("data", () => undefined);
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        fetch: async (request, init) => {
          const signal = init?.signal
            ? AbortSignal.any([init.signal, processAbort.signal])
            : processAbort.signal;
          const response = await fetch(request, { ...init, signal });
          return validateOpenCodeResponse(request, response);
        },
      });
      await client.server.info({ signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      const generation: Generation = {
        client,
        users: 0,
        serviceIdentity: openCodeServiceIdentity({ kind: "owned" }, effectiveEnvironment),
        stop,
        exited,
        ...bridgeBindings(client, bridge),
      };
      this.generations.add(generation);
      process.once("exit", () => {
        this.generations.delete(generation);
        void stop().catch((error: unknown) =>
          logger.warn({ error }, "OpenCode process cleanup failed"),
        );
      });
      return generation;
    } catch (error) {
      await stop();
      throw error;
    }
  }
}
