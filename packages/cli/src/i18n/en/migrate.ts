// Messages of `miyoria host migrate`. What it writes into `host.toml` (including the notes and
// the `--dry-run` preview) is file content, not a message: it is not here.

export const migrate = {
  /** `keys`: the `SING_*` variables, as a list. */
  reviewSing: (keys: string) =>
    `sing: ${keys} stay in [services.sing] env; the GPU arbiter of hostd reads these values, so check that they are still correct`,
  /** `set`: whether the old configuration sets the address. */
  reviewAddress: (module: string, key: string, set: boolean) =>
    `[modules.${module}] ${key}: ${
      set
        ? "set in the old configuration (it no longer has a default; left unchanged in miyoria.toml)"
        : "not set in the old configuration"
    }. No address is needed while hostd on this machine runs the service`,
  exists: (file: string) => `${file} already exists. Add --force to overwrite it.`,
  dryRun: (file: string) => `Would write ${file} (--dry-run: nothing was written)`,
  wrote: (file: string) => `Wrote ${file}`,
  linkNote:
    "Once this machine has joined Core (`miyoria host join`), Core gives the voice node and stage their link address and token through hostd. A machine that has not joined keeps using the voice node's own .env.",
  notCarried: (note: string) => `Not carried over: ${note}`,
  review: (line: string) => `Review: ${line}`,
};
