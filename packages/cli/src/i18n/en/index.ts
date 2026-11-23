// The English catalogue: every message of the CLI. `Messages` is its type, which the other
// languages must match.

import { autostart } from "./autostart.js";
import { cli } from "./cli.js";
import { cluster } from "./cluster.js";
import { common } from "./common.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { discord } from "./discord.js";
import { doctor } from "./doctor.js";
import { host } from "./host.js";
import { init } from "./init.js";
import { memory } from "./memory.js";
import { migrate } from "./migrate.js";
import { models } from "./models.js";
import { node } from "./node.js";
import { profile } from "./profile.js";
import { prompt } from "./prompt.js";
import { remote } from "./remote.js";
import { services } from "./services.js";
import { settings } from "./settings.js";
import { stack } from "./stack.js";
import { update } from "./update.js";
import { validate } from "./validate.js";
import { workspace } from "./workspace.js";

export const en = {
  common,
  cli,
  prompt,
  settings,
  validate,
  workspace,
  init,
  host,
  cluster,
  autostart,
  services,
  models,
  remote,
  node,
  config,
  discord,
  profile,
  migrate,
  memory,
  db,
  doctor,
  update,
  stack,
};

export type Messages = typeof en;
