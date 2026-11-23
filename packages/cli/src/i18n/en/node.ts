// Messages of the commands that run a node in this process (`core`, `chat`, `stage`, `ext`) and
// the offline profile and extension tools.

export const node = {
  noConfig: (file: string) =>
    `${file} not found. Run \`miyoria init\` first to create the configuration.`,
  chatting: (name: string) => `Chatting with ${name} (Ctrl+C to quit).`,
  // ---- stage obs setup ----
  hereOrCollection: "Use either --here or --collection, not both.",
  noProfileConflict: "--no-profile cannot be combined with --profile or --profile-settings.",
  /** One step of the OBS setup, as the Stage describes it. */
  obsStep: (description: string, dryRun: boolean) => `  ${dryRun ? "Would: " : ""}${description}`,
  obsWhere: (collection: string, profile: string) =>
    `scene collection "${collection}", profile "${profile}"`,
  layoutUnknown: (collection: string) =>
    `  (Scene collection "${collection}" already exists; its contents can be read only after switching to it. A real run adds only what is missing.)`,
  /** `steps`: `null` when OBS already has the layout. */
  obsPreview: (steps: number | null, where: string) =>
    `Preview complete: ${
      steps === null ? "OBS already has this layout" : `${steps} ${steps === 1 ? "step" : "steps"}`
    }, in ${where} (OBS was not changed)`,
  obsUnchanged: (where: string) =>
    `OBS already has this layout (${where}); only the masks were updated`,
  obsBuilt: (where: string, steps: number) =>
    `OBS layout built in ${where} (${steps} ${steps === 1 ? "step" : "steps"})`,
  newProfileEmpty: (profile: string) =>
    `The new profile "${profile}" is empty. To stream from OBS, set the stream key (Settings → Stream) and the encoder (Settings → Output) again in this profile.`,
  /** `source`: the name of the OBS source the setup made for the model. */
  vtubeTransparent: (source: string) =>
    `VTube Studio needs a transparent background: choose a solid color background and check "Transparent", so that the OBS source "${source}" shows only the character.`,
  addToStageObs:
    "Add these lines to [stage.obs] in miyoria.toml so that the Stage checks OBS is on the character's scene collection (if it is not, the Stage builds nothing and shows a notice in the admin panel):",
  collectionMismatch: (configured: string, used: string) =>
    `[stage.obs] collection is "${configured}", but this run built in "${used}": while OBS is on that collection, the Stage builds nothing.`,
  // ---- profile ----
  profileSummary: (
    title: string,
    id: string,
    sections: number,
    examples: number,
    voice: boolean,
    avatar: boolean,
  ) =>
    `${title} (${id}): ${sections} persona ${sections === 1 ? "section" : "sections"}, ${examples} example ${
      examples === 1 ? "dialogue" : "dialogues"
    }, voice settings ${voice ? "present" : "absent"}, avatar settings ${avatar ? "present" : "absent"}`,
  // ---- extensions ----
  created: (path: string) => `Created ${path}`,
  installed: (id: string, dir: string) => `Installed ${id} to ${dir}`,
  errors: (n: number) => `${n} ${n === 1 ? "error" : "errors"}`,
  manifestValid: "The manifest is valid",
};
