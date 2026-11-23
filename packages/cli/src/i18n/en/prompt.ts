// Messages of the interactive prompts.

export const prompt = {
  notTty: (hint: string) => `This command needs an interactive terminal; ${hint}`,
  notTtyHint: "in scripts, use `miyoria config set <key> <value>` instead",
  enterKeeps: "(Enter keeps the current value)",
  selectHint: "(↑↓ to move, Enter to select, Esc to go back)",
  multiSelectHint: "(↑↓ to move, Space to toggle, Enter to confirm, Esc to go back)",
};
