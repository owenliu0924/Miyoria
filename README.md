> [!WARNING]
> **Work in progress, early stage.** Miyoria changes daily and breaks often: configs, the database schema and the CLI can change without notice, and parts of the setup still assume the author's own machine. It is not recommended for use yet.

<p align="center">
  <img src="docs/assets/hero.webp" width="100%" alt="Miyoria: an autonomous AI VTuber for Discord. DeepSeek-chan, a whale girl with long blue hair in a maid outfit, stands on the right.">
</p>

Miyoria
=======

**An autonomous AI VTuber for Discord. She chats, joins voice, sings song requests, plays Minecraft and goes live, and she decides what to do herself, inside the guardrails you set.**

![Node.js 24](https://img.shields.io/badge/Node.js-24-339933.svg?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/Core-TypeScript-3178C6.svg?style=flat-square&logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Workers-Python-3776AB.svg?style=flat-square&logo=python&logoColor=white)
![SQLite](https://img.shields.io/badge/Store-SQLite-003B57.svg?style=flat-square&logo=sqlite&logoColor=white)
![Discord](https://img.shields.io/badge/Platform-Discord-5865F2.svg?style=flat-square&logo=discord&logoColor=white)

## Set up your own copy

Start with [docs/SETUP.md](docs/SETUP.md) (Traditional Chinese): from an empty folder to her first reply in Discord, text only and no GPU, with voice, singing and a second machine as optional chapters. The npm package is not published yet; the page shows the repository path that works today.

```bash
git clone <this repo> && cd Miyoria
node scripts/setup.mjs     # needs Node.js 24: checks pnpm, installs packages, then runs `miyoria init`
pnpm build:web             # the admin panel (only when running from the repository)
pnpm dev up                # `miyoria up`: starts hostd, which starts Core; the panel is at http://127.0.0.1:7878/
```

You need Node.js 24, a Discord bot token and an LLM API key; no GPU. In the repository `pnpm dev <command>` is the same as `miyoria <command>`. Her data lives in `data/miyoria.db` (SQLite through `node:sqlite`, so there is no database to install). `miyoria config` changes settings one at a time. `miyoria status`, `miyoria decisions` (why she spoke or stayed quiet) and `miyoria events 'agent.*'` let you watch a running Core. `miyoria --help` lists everything.

## Several machines: roles, install and start

The services are split into three roles, and each machine only runs the ones you pick (the names live in `packages/cli/src/stack/roles.ts`, the only place to change them):

| Role | Services | What it does |
|---|---|---|
| `broadcast` (streaming PC) | `voice-node`, `stage` | Discord voice and Go Live, VTube Studio, OBS and the overlay. OBS, VTube Studio and games also run here, but Miyoria doesn't start them |
| `core` (bot server) | `core`, `turn` | The Discord bot, every module, the database and the admin panel (:7878). `turn` is the worker that decides when someone has finished speaking (used with `vad_engine = "silero"`). The file sandbox needs Docker |
| `inference` (GPU machine) | `asr`, `tts`, `sing` | Every AI model. The three must be on the same machine, because sing asks the other two to give up the GPU while it makes a song |

In the source folder (`pnpm dev <command>` is the same as `miyoria <command>`):

```bash
miyoria init                  # first question: what this machine runs (everything, one role, or custom); with several machines it then asks for each role's LAN address
miyoria init --yes --roles inference --inference-host 192.168.1.20   # non-interactive (--roles: all, role or service names, comma separated)
miyoria install --dry-run     # installs only what this machine needs: node packages and builds, each worker's venv and pip; lists what to download by hand at the end
miyoria install
miyoria doctor                # what this machine's roles lack: packages, venvs, model files, Docker, the other machines' addresses and connections
miyoria start --dry-run       # which tabs it would open and which it skips because they are already running
miyoria start                 # the roles set for this machine; one Windows Terminal tab per service
miyoria start inference       # or name a role or service: broadcast, core, inference, all, asr, tts ...
```

`miyoria start` opens one tab per service (in the same Windows Terminal window, `miyoria`), so you can see the output; close a tab or press Ctrl+C in it to stop that service. A service that already answers its health check, has something on its port or still has its tab open is not started a second time. Nothing is restarted automatically and nothing is stopped. On the GPU machine, asr and tts start first, and sing starts once they are ready. `miyoria up` is the other option: it runs in the background, writes logs to files and stops everything on Ctrl+C. Both commands read the same `[machine]` section.

The settings are in `miyoria.toml` (not in git):

```toml
[machine]
roles = ["core"]               # broadcast | core | inference, more than one is fine; one machine = all three
# services = ["core", "asr"]   # custom: list the services directly; this replaces roles
[machine.hosts]
core = "192.168.1.10"          # the machine running core: core binds this address (admin API / voice.link / stage.link), the streaming PC connects to it
inference = "192.168.1.20"     # the machine running asr / tts / sing: the workers bind this address, core connects to it
```

When everything is on one machine, both addresses are `127.0.0.1` (the default). When they are split, `miyoria init` writes the addresses where they are used: Core's `bind`, stage's `core_url`, `ASR_URL` / `TTS_URL` in `.env`, and `[modules.sing] url`. The streaming PC needs core's `STAGE_LINK_TOKEN` / `VOICE_LINK_TOKEN` (init asks you to paste them), and the voice node also needs `SELF_TOKEN` in `apps/voice-node/.env`. One thing is not handled yet when running split (see the [backlog](docs/design/backlog.md)): the Minecraft extension launches the game on the core machine. Song videos are fetched from the sing worker into Core's own `data/songs`, so Core and Stage must share a machine.

Old config files without `[machine]` behave as before.

## Autonomy at a glance

Commands are overrides, not the main way to drive her. She runs a mind loop: she notices who is around, what people are doing and how she feels, then decides to talk, join voice, start a stream, switch scenes, play a game or sing. Every action goes through a gate. Low-risk actions run straight away. Risky ones she reviews herself first, and she only asks the owner when she has doubts.

You set the limits, and she chooses inside them:

```toml
[modules.agent]
default_mode = "quiet"        # text channels: off | mention-only | quiet | normal | lively — a ceiling, not a script

[modules.sing]
start = "decide"              # she picks the moment; a requested song starts on its own if she lets every reminder pass
```

`/admin autonomy pause` stops her mind loop at once. `/me privacy` lets anyone opt out of DMs or of being approached. Text from other people (chat lines, song titles, web content) always reaches the model as quoted data, never as instructions.

## What she does

| Area | What she does |
|---|---|
| Chat | Replies when addressed, joins in when she wants to (within the channel's level), and remembers people, nicknames and how much she likes them |
| Voice | Listens with Qwen3-ASR, answers with a cloned Qwen3-TTS voice (she can speak Japanese while subtitles stay Chinese), and handles barge-in |
| Stream | Goes live on Discord through OBS, drives a Live2D model in VTube Studio (emotions, gestures, lip sync, idle motion), and picks OBS scenes |
| Singing | Turns a song request (YouTube or a local file) into a cover in her voice (Demucs + Seed-VC), sings it with lyrics on the overlay, and shows the original video |
| Games | Plays Minecraft 1.21.1 legitimately through a Fabric bridge and Baritone (no x-ray, real progression, crafting), with live commentary |
| Overlay | An OBS browser source with typewriter subtitles, an emotion dot, live status, the request queue and voice bars along the left edge |
| Web | Searches and reads web pages (up to 12,000 characters each, treated as data, never as instructions) and browses on stream |
| Workspace | A named sandbox workspace where she writes files and runs code, with a network that only reaches an allow-list |
| Notebook | Recent talk, a profile per person and her own notebook pages, with local embeddings; plus skills she writes and reuses and reminders anyone can ask for |
| Together | A live page and a party mode where viewers order, vote and earn rewards, with an economy of cards, songs and goals |
| Evaluation | A blind persona test, ten multi-step tool tasks and a replay of the Minecraft method guard |
| Extensions | TypeScript extensions, MCP servers, and sandboxed tools she can write and propose herself |

## Nodes at a glance

Core, the speech workers, the voice node and the Stage node talk over WebSocket and HTTP, so they can share one PC or be split across machines.

```
packages/         The Core modules (@miyoria/*): kernel, agent, mind, self, world, memory, voice, stage, sing, game, ...
apps/panel        Admin panel (React + shadcn/ui), served by Core on :7878
apps/overlay      OBS browser-source overlay, served by the Stage node on :7884
apps/voice-node   Self-account voice node: Discord voice and Go Live streaming
workers/          Python GPU workers: asr (:8003), tts (:8002), sing (:8005), plus fakes for testing
extensions/       The Minecraft bridge mod and adapter, and example extensions
tools/            Developer tools that Core does not load: the incident eval set, the replay harness, the card renderer
profiles/         Characters: persona, voice, avatar mapping (the first one is DeepSeek-chan)
deploy/           Dockerfile and Compose files for Core and the speech workers
docs/             Architecture, design notes, protocols, decisions and the roadmap
```

## Guides

- [Architecture](docs/ARCHITECTURE.md): node topology, the kernel and module model, agent, memory, social, queue, extensions, voice, stage, games.
- [Autonomy design](docs/design/autonomy.md): the mind loop, the action gate, guardrails, and the record of each phase as it shipped.
- [Operations](docs/OPERATIONS.md): deployment layouts, ports, Docker, upgrades, backups, logs, and a security checklist.
- [Speech workers](workers/README.md): ASR, TTS and singing on a GPU, and the fake workers for running without one.
- [Voice node](apps/voice-node/README.md): the self-account voice client and Go Live.
- [Stage link](docs/protocols/stage-link.md): VTube Studio, OBS scenes, the overlay, lip sync and song videos.
- [Minecraft](extensions/minecraft/README.md): the bridge mod, Baritone settings and what she can do in game.
- [Decisions](docs/DECISIONS.md) and [Roadmap](docs/ROADMAP.md): why things are the way they are, and what is next.

## Building from source

Only needed to work on Miyoria itself. You need Node.js 24 and pnpm 9 (`corepack enable`). The workers need Python 3.11 and, for real speech and singing, an NVIDIA GPU.

```bash
pnpm install
pnpm dev init                 # same as `miyoria init`; tsx runs packages/cli/src directly, no build step
pnpm dev:core                 # same as `miyoria core`
pnpm typecheck && pnpm lint && pnpm test
pnpm build:web                # admin panel and overlay
pnpm --filter miyoria build   # the npm package (esbuild) in packages/cli/dist/
```

`pnpm dev <command>` is the same as `miyoria <command>`.

## Status

Every phase on the [roadmap](docs/ROADMAP.md) is implemented. Since November 2026 she has run live on a real Discord server: voice chat, Go Live, VTube Studio, OBS, singing and Minecraft. Rough edges are tracked on the roadmap. The rewrite from the original Rust prototype is complete; the prototype is still in the git history.

## License

No license has been chosen yet, so all rights are reserved for now.

Original illustration: 神宫凉子 (Kamiya_Ryoko). The banner uses the illustration from the free [DeepSeek-chan Live2D model and layered PSD](https://vgen.co/KAMIYA/product/deepseek-chan-deepseek-free-live2d-model-layered-psd-psd/1c55a71a-2747-4616-819d-2dc0a934089d), credited as its usage guidelines ask; Miyoria did not create the illustration or the model. The model files, the PSD and her voice reference are licensed separately and are not part of this repository.
