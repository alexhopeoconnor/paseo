<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo</h1>

## Workstation fork

This repository maintains the `workstation` branch of [Paseo](https://github.com/getpaseo/paseo)
against selected upstream releases. The current package is **0.15.2-workstation.1**, based on
upstream **0.15.2**, for **Linux amd64**. See [fork releases](https://github.com/alexhopeoconnor/paseo/releases)
and the [release process](docs/release.md#workstation-fork).

The fork adds confirmed file opening, retained workspace editors and close protection for
[Paseo VSCodium](https://github.com/alexhopeoconnor/paseo-codium), passive project-icon and
subagent reads for [Overview](https://github.com/alexhopeoconnor/paseo-overview), and configurable
long-response previews. In **Settings → Chat**, keep the default 32,000-character preview,
choose a custom limit, or turn it off. Expansion is one-way; streaming responses show activity.
The limit is a rendering safeguard, and disabling it can increase the cost of very large messages.

### Install the workstation package

Download the Debian package and checksums into an empty directory:

```bash
release_url=https://github.com/alexhopeoconnor/paseo/releases/download/workstation-v0.15.2-1
curl --fail --location --remote-name "$release_url/Paseo-0.15.2-workstation.1-amd64.deb"
curl --fail --location --remote-name "$release_url/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
sudo apt install ./Paseo-0.15.2-workstation.1-amd64.deb
/opt/Paseo/resources/bin/paseo --version
```

The checksum command verifies the assets you downloaded. Open **Paseo** from your application
launcher to start the desktop app and its daemon. For a browser/server setup, use the bundled
CLI; a separate Node installation or global npm CLI is unnecessary:

```bash
paseo_cli=/opt/Paseo/resources/bin/paseo
"$paseo_cli" daemon config set features.webUi.enabled true
"$paseo_cli" daemon start
```

Open the daemon's local browser address. Follow the [configuration guide](public-docs/configuration.md)
for the listen address and authentication, and pair a phone through **Settings → your host → Pair Device**.
Use your own provider credentials and an authenticated HTTPS endpoint or the existing encrypted relay
for remote access. Your projects and services do not need the maintainer's directory layout or infrastructure.

Desktop automatic updates are disabled in this distribution. Install future reviewed Debian packages
deliberately and retain the previous package and compatible application-state backup for recovery.
The release also supplies the pinned builder archive for source builds; it is not needed to run Paseo.

### Optional workstation plugins

Open **Settings → Plugins** and enable plugins for this host. Git is needed for
source installs; Docker prepares Overview dependencies and the Codium companion without
installing Node on your host. Install the reviewed Codium revision:

```bash
paseo_cli=/opt/Paseo/resources/bin/paseo
"$paseo_cli" plugin add github:alexhopeoconnor/paseo-codium --ref 7270d0508a502668e9c500a2e64cc0f5349205ca
```

Overview has locked runtime dependencies. Prepare a separate directory for its reviewed
revision before registering it; a direct Git-source install does not run `npm ci`:

```bash
overview_revision=ebd226696e903e13c00ad4d7ec77e45ef3837019
overview_directory="$HOME/.local/share/paseo-plugins/overview-$overview_revision"
mkdir -p "$(dirname "$overview_directory")"
git clone --no-checkout https://github.com/alexhopeoconnor/paseo-overview.git "$overview_directory"
git -C "$overview_directory" checkout --detach "$overview_revision"
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$overview_directory,dst=/work" \
  --workdir /work --env HOME=/tmp \
  node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 \
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
"$paseo_cli" plugin add "$overview_directory"
"$paseo_cli" plugin ls
```

Require both plugins to be enabled and running. Keep the registered Overview directory
in place; prepare a new directory when deliberately selecting a later source revision.

For Codium, follow its [setup guide](https://github.com/alexhopeoconnor/paseo-codium#setup) and
[companion instructions](https://github.com/alexhopeoconnor/paseo-codium/tree/7270d0508a502668e9c500a2e64cc0f5349205ca/companion).
Build the companion from the same source revision. Both services need the same filesystem paths;
embedded mode also requires the same Unix user, the companion, and a framing policy that permits your
Paseo origin. Enter your own HTTPS origin, such as `https://codium.example.com`, in Connection settings.
External-browser mode works without the companion.

Overview needs no companion or persisted settings. It observes activity without loading provider
sessions. Its short streaming excerpts remain bounded independently of the Chat preview preference.
See its [host requirements and acceptance guide](https://github.com/alexhopeoconnor/paseo-overview#host-requirements).

Report fork/package issues in [this repository](https://github.com/alexhopeoconnor/paseo/issues).
Upstream authorship, licenses and notices are retained. The following product overview describes
upstream Paseo; upstream npm packages and Docker images do not include these workstation patches.

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://github.com/getpaseo/paseo/stargazers">
    <img src="https://img.shields.io/github/stars/getpaseo/paseo?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="https://github.com/getpaseo/paseo/releases">
    <img src="https://img.shields.io/github/v/release/getpaseo/paseo?style=flat&logo=github" alt="GitHub release">
  </a>
  <a href="https://x.com/moboudra">
    <img src="https://img.shields.io/badge/%40moboudra-555?logo=x" alt="X">
  </a>
  <a href="https://discord.gg/jz8T2uahpH">
    <img src="https://img.shields.io/badge/Discord-555?logo=discord" alt="Discord">
  </a>
  <a href="https://www.reddit.com/r/PaseoAI/">
    <img src="https://img.shields.io/badge/Reddit-555?logo=reddit" alt="Reddit">
  </a>
</p>

<p align="center">One interface for Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, and Muse Code agents.</p>

<p align="center">
  <img src="https://paseo.sh/hero-mockup.png" alt="Paseo app screenshot" width="100%">
</p>

<p align="center">
  <img src="https://paseo.sh/mobile-mockup.png" alt="Paseo mobile app" width="100%">
</p>

Paseo is an open source agentic development environment for desktop, mobile, web, and CLI. Open the desktop app and work: agents, editor, terminals, diffs, pull requests, and a browser in one window. Run many agents at once, each in its own worktree, on one machine or several. The mobile app is the full app, native on iOS and Android.

- **Parallel agents:** Run many agents at once, each in its own worktree.
- **Built-in orchestration:** Agents in Paseo can create worktrees, launch other agents, and talk to them, across providers.
- **Complete development workflow:** Edit files, review diffs, open pull requests, and run terminals, in split panes you arrange how you want.
- **Self-hosted:** Agents run on your machine with your full dev environment. Use your tools, your configs, and your skills.
- **Multi-provider:** Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, and Muse Code through the same interface. Pick the right model for each job.
- **Voice control:** Dictate tasks or talk through problems in voice mode. Hands-free when you need it.
- **Cross-device:** iOS, Android, desktop, web, and CLI. Start work at your desk, check in from your phone, script it from the terminal.
- **Privacy-first:** Paseo doesn't have any telemetry, tracking, or forced log-ins.

[Run parallel tasks in Paseo](https://paseo.sh/docs/parallel-development): start agents in separate worktrees, review their diffs, run each app, and check it in the built-in browser.

## Sponsors

<!-- Sponsors: one cell per sponsor in the order of packages/website/src/data/sponsors.ts, then "become a sponsor" cells up to three. -->
<table>
  <tr>
    <td align="center" width="33%"><a href="https://hoplite.sh/?utm_source=paseo&utm_medium=readme&utm_campaign=sponsor"><picture><source media="(prefers-color-scheme: dark)" srcset="packages/website/public/sponsors/hoplite-on-dark.svg"><img src="packages/website/public/sponsors/hoplite-on-light.svg" alt="Hoplite" height="56"></picture></a><br><sub>Cloud coding agents</sub></td>
    <td align="center" width="33%"><a href="https://paseo.sh/sponsor">Become a sponsor</a></td>
    <td align="center" width="33%"><a href="https://paseo.sh/sponsor">Become a sponsor</a></td>
  </tr>
</table>

## Plugins

Plugins run on the daemon and show up in every client you connect, with the same UI on desktop, web,
iOS, and Android. Write a plugin once and it is on your phone.

- **UI:** screens, sidebar items, workspace panels, Command Center items, slash commands, composer pills, attachment sources, timeline items, themes.
- **Agent lifecycle:** change configuration, environment, and MCP servers, answer permissions, follow up when a turn ends.
- **Providers:** add a coding agent as a provider.

Install from the registry with `paseo plugin add owner/slug`, or from Git or a local directory.

**[Browse plugins](https://paseo.sh/plugins)** · **[Plugin docs](https://paseo.sh/docs/plugins)**

Plugins run with access to your daemon machine and inside connected clients; install only code you trust.

## Getting Started

Paseo runs a local server called the daemon that manages your coding agents. Clients like the desktop app, mobile app, web app, and CLI connect to it.

### Prerequisites

You need at least one agent CLI installed and configured with your credentials:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex)
- [GitHub Copilot](https://github.com/features/copilot/cli/)
- [OpenCode](https://github.com/anomalyco/opencode)
- [Pi](https://pi.dev)
- [Antigravity](https://paseo.sh/docs/supported-providers#antigravity)
- [Muse Code](https://paseo.sh/docs/muse-code)

### Upstream desktop app

Download it from [paseo.sh/download](https://paseo.sh/download) or the [GitHub releases page](https://github.com/getpaseo/paseo/releases). Open the app and the daemon starts automatically. Nothing else to install.

To connect from your phone, open **Settings → your host → Pair Device**.

### Upstream server

For a server, a VM, or any machine without the desktop app. Install the CLI and start the daemon:

```bash
npm install -g @getpaseo/cli
paseo
```

Paseo starts, then asks whether to enable the end-to-end encrypted relay for device pairing. If you decline, connect directly over TCP, Tailscale, or another VPN. The desktop, mobile, and web apps connect to this daemon like any other host.

For full setup and configuration, see:

- [Docs](https://paseo.sh/docs)
- [Connectivity guide](https://paseo.sh/docs/connectivity)
- [Configuration reference](https://paseo.sh/docs/configuration)

### Upstream Docker image

Run the Paseo daemon and self-hosted web UI in Docker:

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:latest
```

Open `http://localhost:6767` after it starts. Extend the base image with the agent CLIs you use, then provide credentials through environment variables or the persistent `/home/paseo` volume. See the [Docker documentation](docs/docker.md) for full setup details.

## CLI

Everything you can do in the app, you can do from the terminal.

```bash
paseo run --provider claude/opus-4.6 "implement user authentication"
paseo run --provider codex/gpt-5.5 --worktree feature-x "implement feature X"

paseo ls                           # list running agents
paseo attach abc123                # stream live output
paseo send abc123 "also add tests" # follow-up task

# run on a remote daemon; --cwd is a path on that host
paseo run --host workstation.local:6767 --cwd /workspace "run the full test suite"
```

See the [full CLI reference](https://paseo.sh/docs/cli) for more.

## TypeScript SDK

Build issue integrations, dashboards, and orchestration services with `@getpaseo/client`:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

See the [SDK quickstart](https://paseo.sh/docs/sdk/quickstart), [recipes](https://paseo.sh/docs/sdk/recipes), and [API reference](https://paseo.sh/docs/sdk/reference).

## Skills

Skills teach your agent to use Paseo to orchestrate other agents.

```bash
npx skills add getpaseo/paseo
```

Then use them in any agent conversation:

- `/paseo-handoff` — hand off work between agents. I use this to plan with Claude and then handoff to Codex to implement.
- `/paseo-advisor` — spin up a single agent as an advisor for a second opinion, without delegating the work itself.
- `/paseo-committee` — form a committee of two contrasting agents to step back, do root cause analysis, and produce a plan.

## Development

Quick monorepo package map:

- `packages/server`: Paseo daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `paseo` CLI for daemon and agent workflows
- `packages/desktop`: Electron desktop app
- `packages/relay`: Relay transport and encryption used by the daemon and clients
- `packages/website`: Marketing site and documentation (`paseo.sh`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website

# build the server stack
npm run build:server

# repo-wide checks
npm run typecheck
```

## Support Paseo

Paseo is an independent project used by tens of thousands of developers daily, built by one person and funded by the people who use it. Support the work on [GitHub Sponsors](https://github.com/sponsors/boudra). Companies can [sponsor Paseo](https://paseo.sh/sponsor#spot) monthly and have their logo shown at the top of this README and on the paseo.sh homepage and docs.

## Related projects

- [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) — official distributed relay, written in Elixir
- [paseo-vscode](https://marketplace.visualstudio.com/items?itemName=hinnes.paseo-vscode) — VS Code extension

## License

Apache-2.0
