// The way from the member page to her room (docs/design/her-room.md §7.4), shown only while the room
// is open to this member: `GET /api/member/room` answering `open: true`. A Core without the room
// (404) or a room closed to them shows nothing. Apart from the page so the member page does not
// load it.

import { useQuery } from "@tanstack/react-query";
import { House } from "lucide-react";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { Button } from "@/components/ui/button";
import { ROOM_PAGE } from "./path";

export const ROOM_OPEN = ["member", "room", "open"] as const;

export function RoomLink() {
  const api = useApi();
  const state = useQuery({
    queryKey: ROOM_OPEN,
    queryFn: ({ signal }) => api.rpc.room.state(undefined, { signal }),
    // A Core without the room, or a refusal, will not change on a retry.
    retry: (n, e) => !isNotProvided(e) && !(isApiError(e) && e.status < 500) && n < 2,
    staleTime: 60_000,
  });
  if (state.data?.open !== true) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <a href={ROOM_PAGE}>
        <House aria-hidden />
        她的房間
      </a>
    </Button>
  );
}
