// Messages of `miyoria discord commands reset`.

export const discord = {
  noToken:
    "No Discord bot token is set (DISCORD_BOT_TOKEN). Set it in .env or with `miyoria config` → Discord bot.",
  apiStatus: (method: string, route: string, status: number) =>
    `Discord API ${method} ${route} returned ${status}`,
  noApplicationId: "Discord did not return an application ID",
  willDelete: (guilds: number) =>
    `This deletes every slash command of the bot: the global commands and the server commands of ${guilds} ${guilds === 1 ? "server" : "servers"}.`,
  reregistered: " The next start of `miyoria core` registers them again.",
  needYes: "Not running in a terminal: add --yes to confirm.",
  confirm: "Delete them?",
  cancelled: "Cancelled.",
  cleared: (scopes: number) =>
    `Cleared the commands of ${scopes} ${scopes === 1 ? "scope" : "scopes"}`,
  scopeGlobal: "global",
  scopeGuild: (id: string) => `server ${id}`,
  scopeFailed: (scope: string, error: string) => `${scope}: ${error}`,
  someFailed: "Some scopes could not be cleared (the bot may have been removed from that server)",
  restart: "Restart `miyoria core` to register the current commands.",
};
