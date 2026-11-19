---
title: SDK events
description: Subscribe to agent status, timeline, workspace, and provider updates without maintaining a second state model.
nav: Events
order: 56
category: TypeScript SDK
---

# SDK events

Use an owned subscription to fetch a snapshot and follow its changes. On capable daemons, connecting, plain reads, and local directory listeners do not start observation. Each observation gets a new server-issued ID, even when its filter matches another observation.

## Follow one agent's status

```ts
const directory = await client.agents.list({
  filter: { includeArchived: false },
  subscribe: {},
});

directory.subscription.subscribe({
  snapshot({ entries }) {
    const entry = entries.find(({ agent }) => agent.id === agentId);
    console.log(entry?.agent.status);
  },
  update(message) {
    if (message.type !== "agent_update") return;
    const update = message.payload;
    if (update.kind === "upsert" && update.agent.id === agentId) {
      console.log(update.agent.status);
    } else if (update.kind === "remove" && update.agentId === agentId) {
      console.log("Agent removed from this directory");
    }
  },
});

// When this view closes:
await directory.subscription.release();
```

`list({ subscribe: {} })` returns the snapshot, `subscriptionId`, and `subscription`. Omitting `subscribe` returns only a snapshot. Do not supply a subscription ID. The subscription delivers its snapshot before updates and receives a new ID and snapshot after reconnect. Releasing it leaves other observations and the underlying agents intact.

`client.agents.subscribe()` and agent-handle `subscribe()` add local listeners to observations owned by that API instance. They do not request data. Use the returned subscription's callbacks when multiple filtered views need separate updates.

## Follow archive recovery

An `agent_update` upsert can carry `archiveOperation` while the daemon is still resolving an archive or its child cascade. `state` is `"in_progress"` while the archive or stop is still running, `"children_pending"` when one or more child agents still need an archive retry, and `"unresolved"` when the archive could not be completed and needs an explicit retry or other recovery. `canRetry` is advisory permission for another `agent.archive()` call, not a promise that it will finish or that the archive completed.

The successful receipt is exact. `agent.archive()` resolves `{ archivedAt }` for that call and does not include `archiveOperation`. Read the advisory `archiveOperation` from the observed `agent_update` snapshot. An archived parent can still report `children_pending`, so `archivedAt` alone does not prove its descendants are finished. Retrying is explicit; reconnect does not replay an archive request or complete one in the background.

A workspace archive is a separate lifecycle. Its result may report `canceled: true` when an Undo wins before the workspace archive commits; `archivedAt` is then `null`, and `error` is only an optional explanation and may be null. That Undo is not an agent-archive retry. See [archive or detach](./agents.md#archive-or-detach).

## Follow an agent's background work

Background work is what an agent left running after its tool call returned: a Claude shell started with `run_in_background`, a `Monitor` watch, or another task that is not a subagent. Subagents and workflows stay in the agent's subagents.

```ts
const agent = client.agents.ref(agentId);

const unsubscribe = agent.backgroundWork.subscribe((items) => render(items));

// When this view closes:
unsubscribe();
```

`subscribe()` calls the listener with the current list once the subscription is established, again after each reconnect, then with the whole list on every change. Use `list()` for a one-shot read. Each item has `id`, `kind` (`"shell"`, `"monitor"`, or `"other"`; treat unknown values as `"other"`), `description` (or `null`), optional `command`, and `startedAt`, the time Paseo first observed it. Inventory is scoped to the current provider session and is not persisted. When its runtime is lost, its old items are discarded. An unavailable inventory is reported as an error rather than an empty list.

Pass `subscribe(listener, { onError })` to receive setup or list errors. After a setup failure, create a new subscription; after a list failure, the list is read again on the next reconnect. Without `onError`, the error is logged.

`list()` rejects and `subscribe()` throws when the host does not advertise `features.agentBackgroundWork`; ask the user to update the host. For an item with `canStop`, call `backgroundWork.stop(item)` to wait for provider confirmation. Stop requires `features.agentBackgroundWorkStop`.

## Follow timeline events

```ts
const unsubscribe = agent.timeline.subscribe((update) => {
  const { event } = update;
  if (event.type === "subscription_restored") {
    // Live delivery has resumed. Choose whether to fetch missed history.
    console.log("Reconnected; events may have been missed");
    return;
  }
  if (event.type === "error") {
    console.error("Timeline observation stopped:", event.error);
    return;
  }
  if (event.type === "replacement") {
    // Previously fetched history belongs to an old epoch. Fetch the page your UI needs.
    void agent.timeline.refetch().then((page) => console.log(page.entries));
    return;
  }
  if (event.type === "timeline" && event.item.type === "assistant_message") {
    process.stdout.write(event.item.text);
  }

  if (event.type === "turn_completed") {
    console.log("\nTurn completed");
  }
});
```

Await `unsubscribe.ready` before starting work whose events you need to observe. It waits for the initial live subscription (local listener attachment on broadcast-only hosts); initial history is a separate [read](#fetch-timeline-history). Call `unsubscribe()` to release demand, or await `unsubscribe.release()` for teardown.

After reconnect, the same handle receives `{ agentId, subscriptionId, event: { type: "subscription_restored" } }` before subsequent live updates. This is a local SDK notification after membership acknowledgement (local attachment on broadcast-only hosts). The subscription gets a fresh ID. No history is fetched automatically, and missed events are not replayed.

Another caller explicitly loading or refreshing an agent can broadcast provider history to existing timeline observers. These timeline payloads carry `replayed: true`; use them to reconcile history, but ignore them when generating activity animations or notifications. Fresh provider events omit the flag. The flag requires a host and client parser that support it; older client parsers may discard it.

Choose recovery for your consumer: continue live, request a recent page, or call `timeline.refetch({ direction: "after", cursor: { epoch, seq } })` using your saved position. Live delivery continues while your read is pending; buffer or reconcile those events with the returned page by epoch and sequence. Follow `hasNewer` and `endCursor` to read further pages when needed. A live `replacement` invalidates the previous epoch. A failed explicit history read rejects that read and leaves the live subscription active.

Subscription establishment failures deliver `{ agentId, event: { type: "error", error } }` and release the observation. Establish a new subscription when ready to retry. Releasing a subscription stops its callbacks and prevents restoration after reconnect.

Assistant messages can arrive in pieces. Concatenate their text when you need a complete message, or use `run()` and read `lastMessage` when you only need the final reply.

Turn completion comes from `turn_completed`, `turn_failed`, or `turn_canceled`. Do not infer turn completion from an `agent_update` transition to `idle`.

## Fetch timeline history

```ts
const page = await agent.timeline.refetch({
  direction: "before",
  limit: 100,
  projection: "projected",
});

for (const entry of page.entries) {
  console.log(entry.seqStart, entry.seqEnd, entry.item.type);
}
```

Use `startCursor`, `endCursor`, `hasOlder`, and `hasNewer` from the result to page without inventing offsets.

## Follow workspace updates

```ts
const directory = await client.workspaces.list({ subscribe: {} });
directory.subscription.subscribe({
  snapshot({ entries }) {
    console.log(entries);
  },
  update(message) {
    if (message.type === "workspace_update") console.log(message.payload);
  },
});

// When this view closes:
await directory.subscription.release();
```

## Follow provider catalog changes

```ts
const unsubscribe = client.providers.subscribe((update) => {
  const ready = update.entries.filter((entry) => entry.status === "ready");
  console.log(
    "Ready providers:",
    ready.map((entry) => entry.provider),
  );
});
console.log(await client.providers.snapshot());

// When this view closes:
unsubscribe();
```

Provider and project `subscribe()` calls request their own updates and release that demand on unsubscribe. For an initial project cache, buffer updates while awaiting `client.projects.list()`, then apply them after the snapshot.

Call `client.close()` when the application no longer needs the connection.

## Older daemons

The same methods use the existing connection and legacy delivery behavior. Old directory subscriptions
share a server slot: a later filtered observation replaces that slot's filter. Handles have local IDs
and separate callbacks, but independent server filters require an updated daemon. Releasing a handle
detaches its callbacks; old daemons may continue sending broadcasts.

## Native child roster changes

Observe `agent.provider_subagents.update` through `client.observeEvents()`. Descriptor `upsert` and
`remove` payloads carry an optional `{generation, revision}` cursor on hosts supporting passive
roster snapshots. Native timeline events retain their independent `seq`/`epoch`. A `replayed: true`
payload comes from hydration and must not produce fresh activity notifications. Await observation
acknowledgement before reading a passive roster, and reconcile buffered updates as described in
[passive native children](./agents.md#observe-native-children-without-loading-the-parent).
