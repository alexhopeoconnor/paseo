---
title: SDK 事件
description: 订阅 Agent 状态、时间线、工作区和 Provider 的更新，无需维护第二套状态模型。
nav: 事件
---

# SDK 事件 {#sdk-events}

使用一个由你持有的订阅来获取快照并跟踪它的变化。在支持的 daemon 上，建立连接、普通读取和本地目录监听器都不会启动观察。每次观察都会获得一个由服务器签发的新 ID，即使它的过滤条件与另一次观察相同。

## 跟踪一个 Agent 的状态 {#follow-one-agents-status}

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

`list({ subscribe: {} })` 返回快照、`subscriptionId` 和 `subscription`。省略 `subscribe` 时只返回快照。不要自己提供订阅 ID。订阅会先投递快照再投递更新，重连后会获得新的 ID 和快照。释放订阅不会影响其他观察和底层的 Agent。

`client.agents.subscribe()` 和 Agent 句柄上的 `subscribe()` 会为该 API 实例持有的观察添加本地监听器。它们不会请求数据。当多个带过滤条件的视图需要各自的更新时，请使用返回的订阅上的回调。

## 跟踪时间线事件 {#follow-timeline-events}

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

在开始需要观察其事件的工作之前，先 await `unsubscribe.ready`。它会等待初始的实时订阅建立（在只支持广播的主机上则是本地监听器挂载完成）；初始历史是一次单独的[读取](#fetch-timeline-history)。调用 `unsubscribe()` 释放需求，或在清理时 await `unsubscribe.release()`。

重连后，同一个句柄会在后续实时更新之前收到 `{ agentId, subscriptionId, event: { type: "subscription_restored" } }`。这是 SDK 在成员关系确认后（在只支持广播的主机上是本地挂载后）发出的本地通知。订阅会获得一个新的 ID。不会自动获取历史，错过的事件也不会重放。

另一个调用方显式加载或刷新 Agent 时，可能会向现有的时间线观察者广播 Provider 历史。这些时间线 payload
带有 `replayed: true`；可用它们同步历史，但生成活动动画或通知时应忽略它们。新的 Provider 事件不带此标记。
该标记需要主机和客户端解析器都支持；旧版客户端解析器可能会丢弃它。

请为你的使用方选择恢复方式：继续接收实时事件、请求最近一页，或者用你保存的位置调用 `timeline.refetch({ direction: "after", cursor: { epoch, seq } })`。读取进行期间，实时投递会继续；请按 epoch 和序号缓冲这些事件，或与返回的页面进行对账。需要时，根据 `hasNewer` 和 `endCursor` 继续读取后面的页面。实时的 `replacement` 会使之前的 epoch 失效。显式的历史读取失败时，只会让那次读取 reject，实时订阅仍然有效。

订阅建立失败时会投递 `{ agentId, event: { type: "error", error } }` 并释放该观察。准备好重试时，请建立新的订阅。释放订阅会停止它的回调，并阻止重连后的恢复。

助手消息可能分段到达。需要完整消息时请拼接它们的文本；如果只需要最终回复，请使用 `run()` 并读取 `lastMessage`。

一轮的完成由 `turn_completed`、`turn_failed` 或 `turn_canceled` 表示。不要根据 `agent_update` 转为 `idle` 来推断一轮已经完成。

## 获取时间线历史 {#fetch-timeline-history}

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

使用结果中的 `startCursor`、`endCursor`、`hasOlder` 和 `hasNewer` 翻页，不要自己计算偏移量。

## 跟踪工作区更新 {#follow-workspace-updates}

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

## 跟踪 Provider 目录的变化 {#follow-provider-catalog-changes}

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

Provider 和项目的 `subscribe()` 调用会请求各自的更新，并在取消订阅时释放该需求。对于初始的项目缓存，请在 await `client.projects.list()` 期间缓冲更新，拿到快照后再应用它们。

当应用不再需要连接时，调用 `client.close()`。

## 旧版 daemon {#older-daemons}

同样的方法会使用现有的连接和旧的投递行为。旧版的目录订阅共享一个服务器槽位：之后带过滤条件的观察会替换该槽位的过滤条件。句柄有本地 ID 和各自的回调，但独立的服务器端过滤需要更新后的 daemon。释放句柄会解除它的回调；旧版 daemon 可能会继续发送广播。

## 原生子 Agent 列表的变更 {#native-child-roster-changes}

通过 `client.observeEvents()` 观察 `agent.provider_subagents.update`。在支持被动列表快照的主机上，
描述信息的 `upsert` 和 `remove` payload 带有可选的 `{generation, revision}` 游标。原生时间线事件仍然
使用独立的 `seq`/`epoch`。带有 `replayed: true` 的 payload 来自历史数据还原，不得据此发送新活动通知。
读取被动列表前，先等待观察确认，然后按[被动观察原生子 Agent](./agents.md#observe-native-children-without-loading-the-parent)
中的说明合并缓冲的更新。
