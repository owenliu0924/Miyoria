// The people she knows and how she feels about them, and an admin's hand on their coins. Every
// route here is an admin route; the changes go through the social engine and the wallet.

import { z } from "zod";
import { AccountRefSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

/** The permission node of an admin's hand on someone's coins. */
const NODE_ECONOMY_ADJUST = "admin.economy.adjust";

/** One platform account of a person. */
export const PersonAccountSchema = z
  .object({
    account: AccountRefSchema,
    /** Most recently seen display name. */
    display_name: z.string(),
    first_seen: TimestampSchema,
    last_seen: TimestampSchema,
  })
  .meta({ id: "ApiPersonAccount" });
export type PersonAccount = z.output<typeof PersonAccountSchema>;

/** A cross-platform person with their accounts. */
export const PersonSchema = z
  .object({
    id: z.string(),
    /** The display name of the account they were first seen with. */
    display_name: z.string(),
    created_at: TimestampSchema,
    /** In the order they were first seen. */
    accounts: z.array(PersonAccountSchema),
  })
  .meta({ id: "ApiPerson" });
export type Person = z.output<typeof PersonSchema>;

/** How she feels about one person. */
export const RelationshipSchema = z
  .object({
    profile: z.string(),
    person: z.string(),
    /** -100 to 1000 (the bond scale). */
    affinity: z.number(),
    /** 0 to 100. */
    trust: z.number(),
    /** 0 to 100. */
    familiarity: z.number(),
    /** `owner`, `friend`, `regular`, `troll`, `blocked`, ... */
    tags: z.array(z.string()),
    /** Her impression of the person. */
    notes: z.string(),
    /** How she addresses them. */
    call_name: z.string().nullable(),
    interactions: z.number(),
    last_interaction: TimestampSchema.nullable(),
    updated_at: TimestampSchema,
  })
  .meta({ id: "ApiRelationship" });
export type Relationship = z.output<typeof RelationshipSchema>;

/** One change of a relationship; in a history, the levels after it. */
export const RelationshipDeltaSchema = z
  .object({
    at: TimestampSchema,
    affinity: z.number(),
    trust: z.number(),
    familiarity: z.number(),
    /** `appraisal: praise`, `admin: reset`, ... */
    reason: z.string(),
  })
  .meta({ id: "ApiRelationshipDelta" });
export type RelationshipDelta = z.output<typeof RelationshipDeltaSchema>;

/** A person in the list: with or without a relationship. */
export const PersonSummarySchema = z
  .object({
    person: PersonSchema,
    /** `null` before the first interaction. */
    relationship: RelationshipSchema.nullable(),
    /** A short attitude label (`朋友`); a neutral relationship's (`陌生人`) without one. */
    label: z.string().nullable(),
    blocked: z.boolean(),
  })
  .meta({ id: "ApiPersonSummary" });
export type PersonSummary = z.output<typeof PersonSummarySchema>;

/** `GET /api/people/{id}`: the summary's fields and her history with them. */
export const PersonDetailSchema = z
  .object({
    ...PersonSummarySchema.shape,
    /** Oldest first; the values are the levels after each change. */
    history: z.array(RelationshipDeltaSchema),
    memory_count: z.number(),
  })
  .meta({ id: "ApiPersonDetail" });
export type PersonDetail = z.output<typeof PersonDetailSchema>;

/** `GET /api/people`: a page, `next_cursor` opaque and `null` on the last one. */
export const PersonPageSchema = z
  .object({ items: z.array(PersonSummarySchema), next_cursor: z.string().nullable() })
  .meta({ id: "ApiPersonPage" });
export type PersonPage = z.output<typeof PersonPageSchema>;

/**
 * Body of `PATCH /api/people/{id}`; a field left out (or `null`, except `call_name`, where `null`
 * clears it) is unchanged.
 */
export const UpdatePersonRequestSchema = z
  .object({
    /** Replaces every tag except `blocked` (set that with `blocked`). */
    tags: z.array(z.string()).nullish(),
    notes: z.string().nullish(),
    call_name: z.string().nullable().optional(),
    blocked: z.boolean().nullish(),
  })
  .meta({ id: "ApiUpdatePersonRequest" });
export type UpdatePersonRequest = z.input<typeof UpdatePersonRequestSchema>;

/** Body of `POST /api/people/{id}/adjust`: added to the affinity, ignoring the daily caps. */
export const AdjustPersonRequestSchema = z
  .object({ affinity: z.number() })
  .meta({ id: "ApiAdjustPersonRequest" });
export type AdjustPersonRequest = z.input<typeof AdjustPersonRequestSchema>;

/** `GET /api/people/{id}/wallet`: their coins and the newest rows, newest first. */
export const PersonWalletViewSchema = z
  .object({
    balance: z.number(),
    ledger: z.array(z.object({ ts: TimestampSchema, delta: z.number(), label: z.string() })),
  })
  .meta({ id: "ApiPersonWalletView" });
export type PersonWalletView = z.output<typeof PersonWalletViewSchema>;

/**
 * Body of `POST /api/people/{id}/wallet/adjust`: `amount` is a non-zero integer (negative takes
 * coins) up to the economy's limit, `note` 1 to 100 characters, `key` one per confirmed submit (the
 * same key twice answers the first). The server checks each by hand and answers 400 in its own
 * words, so the schema names the fields and leaves their types to it.
 */
export const WalletAdjustRequestSchema = z
  .object({
    amount: z.unknown().optional(),
    note: z.unknown().optional(),
    key: z.unknown().optional(),
  })
  .meta({ id: "ApiWalletAdjustRequest" });
export type WalletAdjustRequest = z.input<typeof WalletAdjustRequestSchema>;

/** What an adjustment did. */
export const WalletAdjustResultSchema = z
  .object({
    balance: z.number(),
    entry_id: z.string(),
    /** The key was used before: nothing new was posted. */
    duplicate: z.boolean(),
  })
  .meta({ id: "ApiWalletAdjustResult" });
export type WalletAdjustResult = z.output<typeof WalletAdjustResultSchema>;

/** A person's id in the path (a ULID, in any case; anything else is a 404). */
const PersonParams = z.object({ id: z.string() });

/** The digits of a `limit` or an offset (`usize`). */
const Usize = z.coerce.number<number | string>().int().min(0);

export const people = {
  /** Everyone she knows, most recent interaction first. */
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people" })
    .input(
      z.object({
        query: z.object({
          /** Matches a name, an account id, a call name or a person id. */
          q: z.string().optional(),
          /** Default 100, at most 500. */
          limit: Usize.optional(),
          /** A previous `next_cursor`. */
          cursor: z.string().optional(),
        }),
      }),
    )
    .output(PersonPageSchema),
  get: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}" })
    .input(z.object({ params: PersonParams }))
    .output(PersonDetailSchema),
  update: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PATCH", path: "/api/people/{id}" })
    .input(z.object({ params: PersonParams, body: UpdatePersonRequestSchema }))
    .output(PersonSummarySchema),
  adjust: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/people/{id}/adjust" })
    .input(z.object({ params: PersonParams, body: AdjustPersonRequestSchema }))
    .output(PersonSummarySchema),
  wallet: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}/wallet" })
    .input(z.object({ params: PersonParams }))
    .output(PersonWalletViewSchema),
  adjustWallet: route
    .meta({ audience: "admin", permission: NODE_ECONOMY_ADJUST })
    .route({ method: "POST", path: "/api/people/{id}/wallet/adjust" })
    .input(z.object({ params: PersonParams, body: WalletAdjustRequestSchema }))
    .output(WalletAdjustResultSchema),
};
