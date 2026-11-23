// Messages of `miyoria init`. A next step is a sentence ending in a colon; the command to type
// follows on its own line.

export const init = {
  intro: "Miyoria setup. Press Ctrl+C at any time to cancel.",
  modeQuestion: "Choose a role for this machine",
  modes: {
    text: "Core node, text only (recommended; no GPU required)",
    voice: "Core node with voice (speech recognition and synthesis here; requires an NVIDIA GPU)",
    service:
      "Service node: provides services, such as GPU singing, to a Core node on another machine",
  },
  sections: {
    profile: "Profile",
    llm: "LLM provider",
    discord: "Discord",
    database: "Database",
    panel: "Admin panel sign-in",
    services: "Services",
  },
  existing:
    "Existing configuration found. Press Enter to keep a value; secrets are kept unless you enter a new one.",
  /** `dir`: where the files go; `null` for the current folder. */
  willCreate: (dir: string | null) =>
    `miyoria.toml, .env, host.toml, the profile and the database folder will be created in ${dir ?? "the current folder"}. Nothing is written until you confirm.`,
  willCopyProfiles: (list: string) => `Bundled profiles to copy: ${list}`,
  willGenerateTokens: (list: string) => `New tokens to generate: ${list}`,
  noApiKey:
    "No LLM API key is set, so Core cannot reply. Run `miyoria config` and choose LLM provider.",
  nextSteps: "Next steps:",
  nextAddVoice:
    "Install speech recognition, speech synthesis and turn detection (requires an NVIDIA GPU; the first run downloads several GB of models):",
  nextUpVoice: "Start Core and these services:",
  nextUpText: "Start Core:",
  nextPanel: "Open the admin panel:",
  nextVoiceLater: "  To add the voice node and singing later, see docs/SETUP.md.",
  nextDoctor: "Check for anything missing:",
  nextConfig: "Change a setting later:",
  // ---- service node ----
  serviceOnly: (file: string) =>
    `Only ${file} is written. This machine does not run Core, so the LLM, Discord and database questions are skipped.`,
  noCatalog:
    "No service catalog found (no service.toml files). Reinstall the miyoria package, or run this from a Miyoria installation.",
  pickServices:
    "Choose the services this machine provides (change them later with `miyoria add` and `miyoria remove`)",
  /** The tag after a service that needs the GPU; `mb`: its peak VRAM, when known. */
  gpuTag: (mb: number | null) =>
    `  [requires a GPU${mb !== null ? `, about ${mb.toLocaleString("en-US")} MB` : ""}]`,
  unknownServices: (unknown: string, available: string) =>
    `Cannot provide ${unknown}: not a service this machine can offer. Available: ${available}`,
  noServices: "No services selected. Without a terminal, name them with --services asr,tts,...",
  hostCreate: (file: string, services: string) => `Create ${file} with services: ${services}`,
  hostUpdate: (file: string, services: string) => `Update ${file}, adding: ${services}`,
  nextAddServices: "Install these services on this machine:",
  nextInvite: "On the Core node, run `miyoria host invite`, then run the command it prints here:",
  nextApprove:
    "Then approve this machine on the Core node; its services are used only after approval:",
  nextUpServices: "Start these services:",
};
