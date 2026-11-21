// `/me market …` (owner 2026-11-21: no new top-level command). Filled in with the picture answers.

import type { CommandRegistry } from "@miyoria/commands";
import type { Pictures } from "@miyoria/types";
import type { ExchangeService } from "./service.js";

export const PATHS = [] as const;

export function registerCommands(
  _registry: CommandRegistry,
  _service: () => ExchangeService,
  _pictures: () => Pictures | null,
): void {}

export function unregisterCommands(_registry: CommandRegistry): void {}
