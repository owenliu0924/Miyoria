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

`miyoria init` first asks what the machine runs:

- **Core, text only**: the Core node, which runs the character (no GPU required).
- **Core with voice**: the Core node with speech recognition and synthesis on the same machine
  (NVIDIA GPU required).
- **Service node**: provides services, such as GPU time for singing, to a Core on another machine.
  It joins that Core with `miyoria host join` and an invite code from `miyoria host invite`.

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
