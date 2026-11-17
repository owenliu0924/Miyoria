import { CommandRegistryKey } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import {
  CardWalletKey,
  Events,
  ParticipationKey,
  PartyRewardsKey,
  type ProfileId,
} from "@miyoria/types";
import { agencyCapabilities } from "./agency-tools.js";
import { EconomyCardWallet } from "./card-wallet.js";
import { EconomyCommands } from "./commands.js";
import { EconomyConfigSchema } from "./config.js";
import { Earnings } from "./earn.js";
import { EconomyService } from "./economy.js";
import { giveCapability, speakerCapabilities } from "./tools.js";
import { EconomyKey } from "./types.js";
import { v2Capabilities } from "./v2-tools.js";
import { Economy2Key } from "./v2-types.js";

/** How often a finished voice window is paid when nobody speaks to end it. */
const VOICE_TICK_MS = 30_000;

/**
 * Module `economy` (docs/design/economy.md): coins people earn by being with her and spend on
 * feeding her and small gifts. Provides `EconomyKey` (the member routes and the Discord commands
 * use it) and registers `economy.give` (her tool `give_coins`) and the speaker's own
 * `economy.accept_food` / `economy.checkin` / `economy.look` and her own money's tools
 * (`economy.treat`, `buy_self`, `post_bounty`, `award_bounty`,
 * `cancel_bounty`; agency-tools.ts, purse.ts, bounties.ts). Also provides `Participation`
 * (the web page's head-pats) and `PartyRewards` (party games, party.ts). Uses `EconomyDocs` (bets,
 * her room) and `LedgerStats` (the health table) when the app provides them, and `CoinLedgerStore`,
 * `RelationshipEffects` (a hair of affinity per gift), `PersonNoteWriter`, `Directives`,
 * `PeopleStore`, `SocialSignals` / `AffectState` (who is blocked), `SelfState` (her hunger),
 * `Singer`, `CommandRegistry`, `ActuatorRegistry` (`stage.expression`), `Moderation` and `EventLog` when present.
 */
export class EconomyModule implements Module {
  static readonly ID = "economy";
  readonly manifest = defineManifest(EconomyModule.ID, "Economy", {
    description: "Coins earned by being with her, spent on feeding her and small gifts",
    optional: [
      "memory",
      "facts",
      "moderation",
      "actions",
      "heart",
      "self",
      "sing",
      "stage.link",
      "commands",
    ],
    configSchema: EconomyConfigSchema,
  });
  readonly #profile: ProfileId;
  #unregister: (() => void) | null = null;
  readonly #commands = new EconomyCommands();

  constructor(profile: ProfileId) {
    this.#profile = profile;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(EconomyConfigSchema);
    const economy = new EconomyService({
      config,
      services: ctx.services,
      profile: this.#profile,
      clock: ctx.clock,
      publish: ctx.publisher,
      log: ctx.log,
    });
    const earnings = new Earnings(economy, config, ctx.services, ctx.log);
    const actuators = actuatorsFor(ctx);
    const off = [
      giveCapability(economy, ctx.services),
      ...speakerCapabilities(economy, ctx.clock),
      ...agencyCapabilities(economy),
      ...v2Capabilities(economy),
    ].map((capability) => actuators.register(capability));
    this.#unregister = () => {
      for (const f of off) f();
    };
    ctx.provide(EconomyKey, economy);
    // Her cards are paid through it (`@miyoria/play/cards`).
    ctx.provide(CardWalletKey, new EconomyCardWallet(economy));
    ctx.provide(ParticipationKey, economy.v2.play);
    ctx.provide(Economy2Key, economy.v2);
    ctx.provide(PartyRewardsKey, economy.v2.party);
    if (!economy.docsAreDurable) {
      ctx.log.warn("no store provides EconomyDocs: bets and the room are kept in memory only");
    }
    const mount = () => {
      const registry = ctx.services.get(CommandRegistryKey);
      if (registry) this.#commands.install(registry, ctx.services);
    };
    mount();

    const events = ctx.subscribe([
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceJoined.type,
      Events.VoiceParticipants.type,
      Events.VoiceLeft.type,
      Events.VoiceUtteranceEvent.type,
      Events.SingCue.type,
    ]);
    ctx.spawn("earn", async () => {
      for await (const env of events) await earnings.onEvent(env, ctx.clock.now());
    });
    // Her bounties run out here; her purse note is written once at the start.
    ctx.spawn("agency", async (signal) => {
      await economy.purse.refresh().catch((error: unknown) => {
        ctx.log.warn({ err: errorMessage(error) }, "cannot write her purse note");
      });
      for await (const _ of interval(Math.max(config.agency_sweep_s, 1) * 1000, signal)) {
        try {
          await economy.bountyDesk.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the bounty sweep failed");
        }
        try {
          await economy.v2.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the economy 2.0 sweep failed");
        }
      }
    });
    ctx.spawn("voice", async (signal) => {
      for await (const _ of interval(VOICE_TICK_MS, signal)) {
        await earnings.settleVoice(ctx.clock.now());
        mount(); // the commands module may have been restarted with a new registry
      }
    });
  }

  async stop(): Promise<void> {
    this.#commands.uninstall();
    this.#unregister?.();
    this.#unregister = null;
  }
}
