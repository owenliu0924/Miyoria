// The `cards` plugin's migrations (docs/design/v5-data.md §3.2, docs/design/v5-play.md §2, §6.3).
// Never edited after they are released: the runner refuses a database whose recorded checksum
// differs. A later change of the catalogue is a new migration (or a row written with its event),
// never an edit of migration 2.
//
// - `cards_card`: one row per card. The drawn parts, her expression, foil and the pose's seed are a
//   snapshot (`parts`), as are the words on it (`face`) and the relationship it shows
//   (`relationship`, words only, never the raw bond); `artifact_id` is its picture once rendered.
// - `cards_parts`: the catalogue a draw picks from (`catalogue.ts`), seeded by migration 2.
// - `cards_pity`: per person, cards in a row without an SR-or-better part.
// - `cards_dex`: per person and part, when it was first drawn, on which card, and how often.
// - `cards_wishlist`: per person, at most three parts (`position` 1..3).
// - `cards_titles`: per person, the series they completed and the title it gave; private unless
//   they make it public.
//
// No foreign key to `persons`, like the heart's and the ledger's tables: forgetting a person
// deletes their rows through the plugin's hook (`store.ts`). Times are epoch microseconds.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`cards_parts\` (
	\`id\` text PRIMARY KEY,
	\`slot\` text NOT NULL,
	\`rarity\` text NOT NULL,
	\`series\` text,
	\`name\` text NOT NULL,
	\`weight\` real DEFAULT 1 NOT NULL,
	\`enabled\` integer DEFAULT 1 NOT NULL,
	\`drop_only\` integer DEFAULT 0 NOT NULL,
	\`blank\` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cards_parts_slot_check" CHECK("slot" IN ('hand', 'accessory', 'outfit', 'pose', 'background')),
	CONSTRAINT "cards_parts_rarity_check" CHECK("rarity" IN ('N', 'R', 'SR', 'SSR')),
	CONSTRAINT "cards_parts_weight_check" CHECK("weight" > 0),
	CONSTRAINT "cards_parts_flags_check" CHECK("enabled" IN (0, 1) AND "drop_only" IN (0, 1) AND "blank" IN (0, 1))
) STRICT;

CREATE TABLE \`cards_card\` (
	\`serial\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`rarity\` text NOT NULL,
	\`parts\` text NOT NULL,
	\`face\` text DEFAULT '{}' NOT NULL,
	\`relationship\` text DEFAULT '{}' NOT NULL,
	\`artifact_id\` text,
	\`price\` integer DEFAULT 0 NOT NULL,
	\`pity_hit\` integer DEFAULT 0 NOT NULL,
	\`wished\` text DEFAULT '[]' NOT NULL,
	\`created_at\` integer NOT NULL,
	CONSTRAINT "cards_card_kind_check" CHECK("kind" IN ('daily', 'milestone', 'keepsake', 'drop')),
	CONSTRAINT "cards_card_rarity_check" CHECK("rarity" IN ('N', 'R', 'SR', 'SSR')),
	CONSTRAINT "cards_card_price_check" CHECK("price" >= 0 AND "pity_hit" IN (0, 1))
) STRICT;

CREATE TABLE \`cards_pity\` (
	\`person_id\` text PRIMARY KEY,
	\`since\` integer DEFAULT 0 NOT NULL,
	\`drawn\` integer DEFAULT 0 NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "cards_pity_check" CHECK("since" >= 0 AND "drawn" >= 0)
) STRICT;

CREATE TABLE \`cards_dex\` (
	\`person_id\` text NOT NULL,
	\`part_id\` text NOT NULL REFERENCES \`cards_parts\`(\`id\`),
	\`first_at\` integer NOT NULL,
	\`first_card\` text,
	\`count\` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY (\`person_id\`, \`part_id\`),
	CONSTRAINT "cards_dex_count_check" CHECK("count" >= 1)
) STRICT;

CREATE TABLE \`cards_wishlist\` (
	\`person_id\` text NOT NULL,
	\`part_id\` text NOT NULL REFERENCES \`cards_parts\`(\`id\`),
	\`position\` integer NOT NULL,
	\`added_at\` integer NOT NULL,
	PRIMARY KEY (\`person_id\`, \`part_id\`),
	CONSTRAINT "cards_wishlist_position_check" CHECK("position" BETWEEN 1 AND 3)
) STRICT;

CREATE TABLE \`cards_titles\` (
	\`person_id\` text NOT NULL,
	\`series\` text NOT NULL,
	\`title\` text NOT NULL,
	\`card\` text,
	\`public\` integer DEFAULT 0 NOT NULL,
	\`earned_at\` integer NOT NULL,
	PRIMARY KEY (\`person_id\`, \`series\`),
	CONSTRAINT "cards_titles_public_check" CHECK("public" IN (0, 1))
) STRICT;

CREATE INDEX \`cards_card_person_idx\` ON \`cards_card\` (\`person_id\`, \`created_at\`);

CREATE INDEX \`cards_card_day_idx\` ON \`cards_card\` (\`person_id\`, \`kind\`, \`created_at\`);

CREATE UNIQUE INDEX \`cards_wishlist_position_idx\` ON \`cards_wishlist\` (\`person_id\`, \`position\`);
`;

/** The catalogue of `SEED_PARTS` (`catalogue.ts`), as released; a test keeps the two equal. */
const CATALOGUE = `INSERT INTO \`cards_parts\` (\`id\`, \`slot\`, \`rarity\`, \`series\`, \`name\`, \`weight\`, \`enabled\`, \`drop_only\`, \`blank\`) VALUES
	('hand.none', 'hand', 'N', NULL, '空手', 1, 1, 0, 1),
	('hand.finger', 'hand', 'R', 'hands', '豎食指', 1, 1, 0, 0),
	('hand.chest', 'hand', 'R', 'hands', '撫胸', 1, 1, 0, 0),
	('hand.foxtail', 'hand', 'R', 'hands', '狗尾草', 1, 1, 0, 0),
	('accessory.none', 'accessory', 'N', NULL, '無配件', 2, 1, 0, 1),
	('accessory.glasses', 'accessory', 'N', 'glasses', '黑框眼鏡', 1, 1, 0, 0),
	('accessory.tail', 'accessory', 'R', 'curios', '尾巴', 1, 1, 0, 0),
	('accessory.monocle', 'accessory', 'SR', 'glasses', '單片眼鏡', 1, 1, 0, 0),
	('accessory.basin', 'accessory', 'SR', 'curios', '大鋼盆', 1, 1, 0, 0),
	('accessory.monocle_tail', 'accessory', 'SSR', 'curios', '單片眼鏡和尾巴', 1, 1, 0, 0),
	('outfit.usual', 'outfit', 'N', 'wardrobe', '平常的衣服', 1, 1, 0, 0),
	('outfit.long_skirt', 'outfit', 'R', 'wardrobe', '長裙', 1, 1, 0, 0),
	('outfit.short_skirt', 'outfit', 'R', 'wardrobe', '短裙', 1, 1, 0, 0),
	('outfit.shoes', 'outfit', 'R', 'wardrobe', '換一雙鞋', 1, 1, 0, 0),
	('outfit.top', 'outfit', 'R', 'wardrobe', '胸口的衣服', 1, 1, 0, 0),
	('pose.front', 'pose', 'N', 'poses', '正面', 1, 1, 0, 0),
	('pose.tilt_left', 'pose', 'N', 'poses', '歪頭(左)', 1, 1, 0, 0),
	('pose.tilt_right', 'pose', 'N', 'poses', '歪頭(右)', 1, 1, 0, 0),
	('pose.look_up', 'pose', 'N', 'poses', '抬頭', 1, 1, 0, 0),
	('pose.lean_in', 'pose', 'R', 'poses', '湊近', 1, 1, 0, 0),
	('pose.shy', 'pose', 'R', 'poses', '害羞低頭', 1, 1, 0, 0),
	('pose.sway', 'pose', 'R', 'poses', '搖擺', 1, 1, 0, 0),
	('pose.turn_left', 'pose', 'R', 'poses', '側身回頭(左)', 1, 1, 0, 0),
	('pose.turn_right', 'pose', 'R', 'poses', '側身回頭(右)', 1, 1, 0, 0),
	('background.gradient_pink', 'background', 'N', 'colours', '她的顏色・粉', 1, 1, 0, 0),
	('background.gradient_blue', 'background', 'N', 'colours', '她的顏色・藍', 1, 1, 0, 0),
	('background.bokeh', 'background', 'N', 'colours', '光斑', 1, 1, 0, 0),
	('background.bokeh_night', 'background', 'R', 'colours', '夜裡的光斑', 1, 1, 0, 0),
	('background.stars', 'background', 'R', 'sky', '星點', 1, 1, 0, 0),
	('background.water', 'background', 'R', 'water', '水面', 1, 1, 0, 0),
	('background.night_sky', 'background', 'SR', 'sky', '夜空', 1, 1, 0, 0),
	('background.moon_water', 'background', 'SR', 'water', '月下的水面', 1, 1, 0, 0),
	('background.meteor', 'background', 'SSR', 'sky', '流星夜空', 1, 1, 0, 0),
	('background.aurora', 'background', 'SSR', 'sky', '極光', 1, 1, 0, 0),
	('background.fireworks', 'background', 'SR', NULL, '頻道裡的煙火', 1, 1, 1, 0);
`;

/** Her cards for each person, the catalogue they are drawn from, the pity, the dex, wishes, titles. */
export const cardsSchema: PluginSchema = {
  plugin: "cards",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "catalogue", sql: CATALOGUE },
  ],
};
