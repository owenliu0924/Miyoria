// `page_publish`, `page_list`, `page_unpublish`: she puts a web page she made on the file origin,
// where a browser renders it (`https://<file origin>/p/<slug>/`), and takes it back.
//
// A tool of its own rather than a mode of `share`: `share` posts a file into the conversation and
// its link serves bytes as a download; a page posts nothing, renders, has its own headers, a banner,
// files it loads by relative path and a life of weeks, and can be listed and taken back.
//
// Here are the rules of who and what, as for `share`: someone asked (the gate's `permit` already
// held: the workspace node, or a bond at `work_min_bond`); every file of the page is an artifact of
// the store, live, made where it is asked for or wider, and made for the person who asked (their
// own folder) unless an owner asks. What a page may hold, its size, expiry, quota and how it is
// served are the file origin's (`FilePagesKey`, the `api` module). A page counts toward the same
// daily share limit as an attachment.

import type { ServiceLookup } from "@miyoria/runtime/kernel";
import {
  type Artifact,
  type ArtifactPage,
  type ArtifactStore,
  ArtifactStoreKey,
  FilePagesKey,
} from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  type Clock,
  escapeData,
  type JsonValue,
  type Principal,
  systemClock,
} from "@miyoria/types";
import { z } from "zod";
import { type ActionResult, type Capability, defineCapability } from "./capability.js";
import type { ShareConfig } from "./config.js";
import type { RateLimiter } from "./rate.js";
import { SHARE, shareLimits } from "./share.js";
import { SANDBOX_WORKSPACE, WORKSPACE_ALL } from "./work.js";

export const PAGE_PUBLISH = "page.publish";
export const PAGE_LIST = "page.list";
export const PAGE_UNPUBLISH = "page.unpublish";

const PagePublishArgs = z.object({
  artifact: z.string().trim().min(1).max(64),
  assets: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(200),
        artifact: z.string().trim().min(1).max(64),
      }),
    )
    .max(64)
    .nullish(),
  to: z.string().nullish(),
  days: z.number().int().min(1).max(365).nullish(),
});
type PagePublishArgs = z.output<typeof PagePublishArgs>;

const PageListArgs = z.object({});
type PageListArgs = z.output<typeof PageListArgs>;

const PageUnpublishArgs = z.object({ page: z.string().trim().min(1).max(64) });
type PageUnpublishArgs = z.output<typeof PageUnpublishArgs>;

export interface PageOptions {
  services: ServiceLookup;
  /** `[modules.actions.share]`: its daily limits count pages too. */
  config: () => ShareConfig;
  /** The limiter `share` counts with, shared. */
  limiter: RateLimiter;
  clock?: Clock;
}

function refused(code: string, text: string, extra: Record<string, JsonValue> = {}): ActionResult {
  return { text, data: { ok: false, refused: code, ...extra } };
}

const personKey = (account: AccountRef) => `${account.platform}:${account.id}`;

/** Whether the person asking is an owner (they reach every folder, and every page). */
function isOwner(services: ServiceLookup, who: AccountRef): boolean {
  return services.get(AuthorizerKey)?.allows(who, WORKSPACE_ALL) === true;
}

/** Who a page is for, in her words. */
function audienceWords(audience: string): string {
  return audience === "link"
    ? "有網址的人都打得開"
    : audience === "space"
      ? "這個伺服器的成員登入後打得開"
      : "只有對方登入後打得開";
}

/** `2026-12-23` of a timestamp. */
const day = (at: string) => at.slice(0, 10);

/** The store, the asker and their place; or the refusal. */
function asker(
  services: ServiceLookup,
  principal: Principal,
):
  | {
      store: ArtifactStore;
      who: AccountRef;
      person: string;
      site: NonNullable<ReturnType<ArtifactStore["places"]["at"]>>;
      owner: boolean;
    }
  | ActionResult {
  const store = services.get(ArtifactStoreKey);
  if (!store) return refused("unavailable", "現在沒有產物庫,沒辦法處理網頁。");
  const who = principal.requester;
  const where = principal.context;
  if (who === null || where === null) {
    return refused("no_requester", "這次沒有人開口要網頁,所以不做。");
  }
  const site = store.places.at(where, who, { create: true });
  if (site === null || site.person_id === null) {
    return refused("unknown_place", "我認不出這個地方或開口的人,所以不做。");
  }
  return { store, who, person: site.person_id, site, owner: isOwner(services, who) };
}

/** `page_publish`, `page_list` and `page_unpublish`. */
export function pageCapabilities(options: PageOptions): Capability[] {
  const { services, limiter } = options;
  const clock = options.clock ?? systemClock;

  const publish = defineCapability<PagePublishArgs>({
    name: PAGE_PUBLISH,
    summary: "把她做的網頁發到檔案網域,給一個能在瀏覽器打開的網址",
    risk: "low",
    args: PagePublishArgs,
    permission: SANDBOX_WORKSPACE,
    tool: {
      name: "page_publish",
      meta: { effect: "act", speed: "instant", group: "files", core: true },
      description:
        "把你做的網頁發到檔案網域,回給你一個在瀏覽器裡直接打開、會顯示成網頁的網址;有人想在瀏覽器裡打開你做的網頁就用這個,不是用 share 傳檔案。" +
        "artifact 填網頁本身(.html)用 workspace_export 存成產物的 id。網頁用到的 css、js、圖片這些檔案也各自匯出,放進 assets:" +
        "path 是網頁裡引用它的相對路徑(例如 style.css、img/cat.png),artifact 是它的產物 id;只有一個 .html 檔(樣式和程式都寫在裡面)就不用 assets。" +
        "to 省略或 speaker:只有開口要的人登入後打得開;here:這個伺服器的成員登入後打得開;anyone:有網址的人都打得開(主人有開才行)。" +
        "days 是幾天後下架,省略就用預設。網頁上不能送出表單、不能連到別的網站拿資料或載入外面的程式,上面會有一條橫幅寫著這是成員請你做的、不是官方網站。" +
        "不行的時候會告訴你原因,照原因跟對方說就好。",
      properties: {
        artifact: { type: "string", description: "網頁本身(.html)的產物 id" },
        assets: {
          type: "array",
          description: "網頁用到的其他檔案:每個是 {path, artifact}",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "網頁裡引用它的相對路徑,例如 style.css" },
              artifact: { type: "string", description: "這個檔案的產物 id" },
            },
            required: ["path", "artifact"],
          },
        },
        to: {
          type: "string",
          description: "給誰:省略或 speaker(開口要的人);here(這個伺服器的成員);anyone(有網址的人)",
        },
        days: { type: "integer", description: "幾天後下架;省略是預設" },
      },
      required: ["artifact"],
    },
    async execute(args, ctx): Promise<ActionResult> {
      const a = asker(services, ctx.principal);
      if ("text" in a) return a;
      const { store, who, site, owner } = a;
      const files = [
        { path: null as string | null, id: args.artifact },
        ...(args.assets ?? []).map((x) => ({ path: x.path as string | null, id: x.artifact })),
      ];
      const own: Artifact[] = [];
      for (const file of files) {
        const what = file.path === null ? "網頁本身" : `網頁裡的 ${escapeData(file.path)}`;
        const artifact = store.get(file.id);
        if (artifact === null) {
          return refused(
            "not_found",
            `${what}的產物 id 不在產物庫裡。每個檔案都要先用 workspace_export 存成產物,再用它回給你的 id。`,
            file.path === null ? {} : { path: file.path },
          );
        }
        if (artifact.source === "sing" || !artifact.downloadable) {
          return refused("song_cover", "翻唱的成品不開放下載,不能放進網頁。");
        }
        if (!store.isLive(artifact)) {
          return refused("withdrawn", `${what}已經不在了(過期、刪除或被下架)。`);
        }
        if (!store.visibleTo(artifact, site.viewer)) {
          return refused(
            "wider_than_origin",
            `${what}不是在這裡做的:私訊裡做的只能在那個私訊裡發,頻道裡做的只能在那個頻道發。`,
          );
        }
        if (artifact.made_for !== site.person_id && !owner) {
          return refused("not_for_them", `${what}不是幫開口的人做的,不能拿來發他的網頁。`);
        }
        own.push(artifact);
      }
      const pages = services.get(FilePagesKey);
      if (pages === undefined) {
        return refused("unavailable", "檔案網域沒有設定,所以現在發不了網頁。");
      }
      const to = args.to?.trim().toLowerCase() ?? "";
      const audience = to === "anyone" ? "link" : to === "here" ? "space" : "person";
      if (audience === "space" && site.dm) {
        return refused("wider_than_origin", "私訊裡沒有「這個伺服器的成員」,只能給對方本人。");
      }
      const exceeded = limiter.check(
        SHARE,
        personKey(who),
        shareLimits(options.config()),
        clock.now(),
      );
      if (exceeded !== null) {
        return refused("limit", "今天給這個人(或大家)的檔案和網頁已經到上限了,明天再發。", {
          reason: exceeded,
        });
      }
      const result = await pages.publish(
        {
          artifact_id: args.artifact,
          assets: (args.assets ?? []).map((x) => ({ path: x.path, artifact_id: x.artifact })),
          audience,
          person_id: audience === "person" ? site.person_id : null,
          space_id: audience === "space" ? site.place.space_id : null,
          days: args.days ?? null,
          requested_by: site.person_id,
          turn: ctx.request.turn,
          // Anyone may open it only when every file is the asker's own.
          widen: audience === "link" && own.every((x) => x.made_for === site.person_id),
        },
        ctx.signal,
      );
      if (!result.ok) {
        return refused(
          result.refused,
          result.message,
          result.path === undefined ? {} : { path: result.path },
        );
      }
      limiter.record(SHARE, personKey(who), clock.now());
      return {
        text:
          `網頁發好了:${result.url} (${audienceWords(result.audience)},${day(result.expires_at)} 下架)。` +
          "把網址給對方就好;要提早拿下來用 page_unpublish。",
        data: {
          ok: true,
          page_id: result.page_id,
          url: result.url,
          audience: result.audience,
          expires_at: result.expires_at,
          size: result.size,
        },
      };
    },
  });

  const list = defineCapability<PageListArgs>({
    name: PAGE_LIST,
    summary: "列出她幫開口的人發的網頁(主人看得到全部)",
    risk: "low",
    args: PageListArgs,
    permission: SANDBOX_WORKSPACE,
    tool: {
      name: "page_list",
      meta: { effect: "read", speed: "instant", group: "files", core: false },
      description:
        "列出你用 page_publish 幫開口的人發的、還在線上的網頁:id、網址、誰打得開、哪天下架。主人問的話列出全部。",
      properties: {},
      readOnly: true,
    },
    async execute(_args, ctx): Promise<ActionResult> {
      const a = asker(services, ctx.principal);
      if ("text" in a) return a;
      const { store, person, owner } = a;
      const found = store.pages.list({
        ...(owner ? {} : { made_for: person as never }),
        open: true,
        limit: 50,
      });
      const urlOf = (p: ArtifactPage) => services.get(FilePagesKey)?.urlOf(p.slug) ?? null;
      if (found.length === 0) {
        return { text: "現在沒有還在線上的網頁。", data: { ok: true, pages: [] } };
      }
      const lines = found.map((p) => {
        const url = urlOf(p) ?? "(檔案網域沒有設定,現在打不開)";
        return `- ${p.id}:${url}(${audienceWords(p.audience)},${day(p.expires_at)} 下架)`;
      });
      return {
        text: `還在線上的網頁:\n${lines.join("\n")}`,
        data: {
          ok: true,
          pages: found.map((p) => ({
            page_id: p.id,
            url: urlOf(p),
            audience: p.audience,
            expires_at: p.expires_at,
            made_for: p.made_for,
          })),
        },
      };
    },
  });

  const unpublish = defineCapability<PageUnpublishArgs>({
    name: PAGE_UNPUBLISH,
    summary: "把她發過的一個網頁拿下來",
    risk: "low",
    args: PageUnpublishArgs,
    permission: SANDBOX_WORKSPACE,
    tool: {
      name: "page_unpublish",
      meta: { effect: "act", speed: "instant", group: "files", core: false },
      description:
        "把一個用 page_publish 發的網頁馬上拿下來,網址就打不開了。page 填網頁的 id(page_publish 或 page_list 給你的)。只能拿下開口的人自己的網頁;主人可以拿下任何一個。",
      properties: { page: { type: "string", description: "網頁的 id" } },
      required: ["page"],
    },
    async execute(args, ctx): Promise<ActionResult> {
      const a = asker(services, ctx.principal);
      if ("text" in a) return a;
      const { store, person, owner } = a;
      const page = store.pages.get(args.page);
      if (page === null || (page.made_for !== person && !owner)) {
        return refused("not_found", "找不到這個網頁(或它不是開口的人的)。");
      }
      const done = store.pages.revoke(page.id);
      return {
        text: done ? "網頁拿下來了,網址已經打不開。" : "這個網頁之前就已經拿下來了。",
        data: { ok: true, page_id: page.id, revoked: done },
      };
    },
  });

  return [publish, list, unpublish] as Capability[];
}
