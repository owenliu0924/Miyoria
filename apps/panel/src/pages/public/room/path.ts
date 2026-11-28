// Where her room lives (docs/design/her-room.md §1), apart from the page so the member area can link
// to it without loading it.

/** The member's room with her. */
export const ROOM_PAGE = "/her";

/** Whether `path` (path and query) is her room. */
export function isRoomPath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare === ROOM_PAGE || bare === `${ROOM_PAGE}/`;
}
