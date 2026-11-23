# miyoria

The command-line tool of Miyoria, an AI VTuber framework for Discord. It sets up a machine,
starts its services through the host daemon (hostd) that supervises them, and manages the
configuration.

```sh
pnpm dlx miyoria@latest init   # setup wizard
miyoria up                     # start this machine's services
miyoria status                 # services of this machine and the running Core
miyoria --help                 # every command
```

`miyoria init` first asks for the role of the machine:

- **Core node, text only**: runs Core, the character itself (recommended; no GPU required).
- **Core node with voice**: also runs speech recognition and synthesis (requires an NVIDIA GPU).
- **Service node**: provides services, such as GPU singing, to a Core node on another machine.
  It joins that Core with `miyoria host join` and an invite code from `miyoria host invite`.

## Scripts and automation

- `miyoria init --non-interactive` asks nothing and keeps every default (`init --yes` is an
  alias). Secrets are read from `MIYORIA_LLM_API_KEY` and `MIYORIA_DISCORD_BOT_TOKEN`, or from
  stdin with `--llm-key-stdin` and `--discord-token-stdin` (one per line, the LLM key first),
  never from an option value:

  ```sh
  printf '%s\n' "$LLM_KEY" | miyoria init --non-interactive --llm-key-stdin
  ```

- `--yes` answers yes to every confirmation.
- `--json` on `status`, `doctor`, `host ls` and `config list` prints one JSON document on stdout
  and nothing else. Each document has a `schema` field (`miyoria.status/1`, `miyoria.doctor/1`,
  `miyoria.hosts/1`, `miyoria.config-list/1`); its types are `StatusJson`, `DoctorJson`,
  `HostsJson` and `ConfigListJson` in the source. Display text inside them (`what`, `detail`,
  `reason`) follows the language; keys and state names do not.
- Results go to stdout; notes, warnings and errors go to stderr. Exit codes: 0 on success, 1 when
  a command fails (for `doctor`, when a check fails), 2 on a usage error, 130 when cancelled.

## Language

Messages are in English or Traditional Chinese. The language is chosen in this order:

1. `--lang <en|zh-TW>` on the command line, for example `miyoria --lang zh-TW status`.
2. The `MIYORIA_LANG` environment variable (`en` or `zh-TW`; a locale name such as `zh_TW.UTF-8`
   also works).
3. The system locale: `LC_ALL`, then `LC_MESSAGES`, then `LANG`; where none is set (as on
   Windows), the display language of the system.

A Traditional Chinese locale (`zh-TW`, `zh-HK`, `zh-MO`, or any `zh-Hant` locale) selects
Traditional Chinese. Every other locale, Simplified Chinese included, selects English.

The language changes only messages. Configuration files, file contents written by the CLI, exit
codes and output meant for other programs are the same in every language.
