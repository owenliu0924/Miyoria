// Messages of `miyoria models pull | ls | gc`.

export const models = {
  /** `3 items`, `1 item`. */
  items: (n: number) => `${n} ${n === 1 ? "item" : "items"}`,
  notInCatalog: (name: string) => `The catalog has no service named ${name}.`,
  notAdded: (name: string) =>
    `${name} is not a service of this machine yet. Run \`miyoria add ${name}\` first.`,
  pulling: (name: string) => `${name}: downloading models`,
  unpinned: (repo: string) =>
    `service.toml sets no revision for ${repo}: the latest commit of the default branch was downloaded, not a pinned one.`,
  nothingToPull: "No models to download",
  pullFailed: (n: number) => `${n} ${n === 1 ? "model was" : "models were"} not downloaded`,
  folder: (dir: string) => `Model folder ${dir}`,
  empty: "No models yet (`miyoria models pull`, or `miyoria add <service>` for the small files)",
  unused: "not used by any service",
  disabled: (name: string) => `${name} (disabled)`,
  file: "file",
  /** `items`: `items`. */
  total: (items: string, size: string) => `${items}, ${size}`,
  gcTitle: "Models no enabled service uses",
  gcNotConfirmed: "Nothing deleted (to delete, add --yes or run this in a terminal)",
  gcConfirm: (items: string, size: string) =>
    `Delete the ${items} above (${size})? This cannot be undone.`,
  allUsed: "Every model is used by an enabled service",
  deleted: (items: string, size: string) => `Deleted ${items}, freed ${size}`,
};
