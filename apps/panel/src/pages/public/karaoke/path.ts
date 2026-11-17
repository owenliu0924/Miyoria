// Where the karaoke page lives, apart from the page so the member page can link to it without
// loading it.

/** The member's karaoke page. */
export const KARAOKE_PAGE = "/karaoke";

/** Whether `path` (path and query) is the karaoke page. */
export function isKaraokePath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare === KARAOKE_PAGE || bare === `${KARAOKE_PAGE}/`;
}
