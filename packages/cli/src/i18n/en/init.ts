// Messages of `miyoria init`.

export const init = {
  intro: "Miyoria setup",
  modeQuestion: "What will this machine run? (Run init again to change this later.)",
  modes: {
    text: "Core, text only (no GPU required)",
    voice:
      "Core with voice: speech recognition and synthesis on this machine (NVIDIA GPU required)",
    service: "Worker node: provide services to a remote Core (for example, GPU time for singing)",
  },
  sections: {
    profile: "Profile",
    llm: "LLM",
    discord: "Discord",
    database: "Database",
    panel: "Admin panel",
    services: "Services",
  },
  existing:
    "Existing configuration loaded. Press Enter to keep the current value of any question; secrets stay unchanged unless you type a new one.",
  /** `dir`: where the files go; `null` for the current folder. */
  willCreate: (dir: string | null) =>
    `miyoria.toml, .env, host.toml, the profile and the database folder will be created in ${dir ?? "the current folder"}. Nothing is written until you confirm.`,
  willCopyProfiles: (list: string) => `Bundled profiles to copy: ${list}`,
  willGenerateTokens: (list: string) => `New tokens to generate: ${list}`,
  noApiKey:
    "No LLM API key is set. Add one with `miyoria config` → LLM, or run `miyoria init` again.",
  nextSteps: "Next steps:",
  nextAddVoice:
    "Set up speech recognition, speech synthesis and turn detection (NVIDIA GPU required; the first run downloads several GB of models)",
  nextUpVoice: "Start Core and these services",
  nextUpText: "Start Core",
  nextPanel: (url: string) => `  Admin panel: ${url}. Talk to the character directly in Discord.`,
  nextVoiceLater:
    "  Add the voice node (the client that joins Discord voice channels) and singing later; see docs/SETUP.md.",
  nextDoctor: "Check for anything missing",
  nextConfig: "Change individual settings later",
  // ---- worker node ----
  serviceOnly: (file: string) =>
    `Only ${file} is written. This machine does not run Core, so the LLM, Discord and database questions are skipped.`,
  noCatalog:
    "No service catalog found (no service.toml files). The package is incomplete, or this is not a Miyoria installation.",
  pickServices:
    "Services to provide from this machine (change them later with `miyoria add` and `miyoria remove`)",
  /** The tag after a service that needs the GPU; `mb`: its peak VRAM, when known. */
  gpuTag: (mb: number | null) =>
    `  [GPU required${mb !== null ? `, about ${mb.toLocaleString("en-US")} MB` : ""}]`,
  unknownServices: (unknown: string, available: string) =>
    `Cannot provide ${unknown}: not a service this machine can offer. Available: ${available}`,
  noServices: "No services selected. Without a terminal, name them with --services asr,tts,...",
  hostCreate: (file: string, services: string) => `Create ${file} with services: ${services}`,
  hostUpdate: (file: string, services: string) => `Update ${file}, adding: ${services}`,
  nextAddServices: "Install these services on this machine (uv environments and missing files)",
  nextInvite:
    "  Ask the operator of the Core node to run `miyoria host invite` there, then run the command it prints on this machine:",
  joinCommand: (cmd: string) => `    ${cmd} host join <address> --code <code>`,
  nextApprove: (name: string) =>
    `  The operator then approves this machine with \`miyoria host approve ${name}\`. Its services are used only after approval.`,
  nextUpServices: "Start these services",
};
