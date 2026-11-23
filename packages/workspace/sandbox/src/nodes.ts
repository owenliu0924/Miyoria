// Permission nodes of the sandbox's capabilities (kept apart from `gate.ts` so the capability
// files can share them without importing each other).

/** Permission nodes a `user` principal needs to ask for these (she can still act `on_own`). */
export const NODE_CODE_RUN = "sandbox.code.run";
/** Her file tools; a bond at `work_min_bond` counts as it (`WORK_NODES`). */
export const NODE_WORKSPACE = "sandbox.workspace";
export const NODE_TOOL_PROPOSE = "sandbox.tool.propose";
/** `tools.sandbox.<name>`: trusted and above have it through `tools.*`. */
export const NODE_PROPOSED_PREFIX = "tools.sandbox.";
