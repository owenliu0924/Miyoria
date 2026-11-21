// Words for free-form gifts (docs/design/economy.md §16), shared by the member page, the public
// collection and 經濟 / 禮物.

import type { AdminGiftItem, GiftViewItem } from "@miyoria/contracts/api";

type Status = GiftViewItem["status"];
type Kind = NonNullable<GiftViewItem["kind"]>;

/** What happened to a gift, as its giver reads it. */
export const GIFT_STATUS: Record<Status, string> = {
  pending: "等你確認",
  cancelled: "取消了",
  expired: "過期了",
  rejected: "送不出去",
  confirmed: "等她回應",
  accepted: "她收下了",
  refused: "她沒收,已退回",
  refunded: "已退款",
  refund_due: "等待退款",
};

/** The same, as the owner reads it. */
export const GIFT_STATUS_ADMIN: Record<Status, string> = {
  pending: "等確認",
  cancelled: "取消了",
  expired: "過期了",
  rejected: "送不出去",
  confirmed: "等她回應",
  accepted: "收下了",
  refused: "她沒收",
  refunded: "已退款",
  refund_due: "待退款",
};

export const GIFT_KIND: Record<Kind, string> = {
  food: "吃的",
  drink: "喝的",
  small_object: "小東西",
  big_object: "大東西",
  experience: "一段經驗",
};

export const GIFT_KINDS = Object.keys(GIFT_KIND) as Kind[];

export const PRICED_BY: Record<AdminGiftItem["priced_by"], string> = {
  model: "模型估的",
  cache: "估過的",
  pinned: "你指定的",
  fallback: "預設價",
  rule: "規則",
};

/** `2026.11.21`. */
export function giftDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
