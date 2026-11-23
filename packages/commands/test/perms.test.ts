import { describe, expect, it } from "vitest";
import {
  builtinRole,
  builtinRoleGrants,
  granted,
  matches,
  Permissions,
  parseAccount,
  SKILLS_MANAGE,
  WORK_BOND,
  WORK_DELEGATE,
  WORK_NODES,
  WORKSPACE_ALL,
} from "../src/index.js";
import { guildContext, inv } from "./helpers.js";

describe("permissions", () => {
  it("roles_and_checks", () => {
    const perms = Permissions.fromStrings(["discord:1"]);
    const owner = inv("x", "1", {}, guildContext);
    const admin = inv("x", "2", {}, guildContext);
    admin.invoker_is_guild_admin = true;
    const user = inv("x", "3", {}, guildContext);
    expect(perms.roleOf(owner)).toBe("owner");
    expect(perms.roleOf(admin)).toBe("admin");
    expect(perms.roleOf(user)).toBe("user");

    expect(perms.allowsInvocation(owner, "owner.x")).toBe(true);
    expect(perms.allowsInvocation(owner, "admin.x")).toBe(true);
    expect(perms.allowsInvocation(admin, "owner.x")).toBe(false);
    expect(perms.allowsInvocation(admin, "admin.x")).toBe(true);
    expect(perms.allowsInvocation(user, "admin.x")).toBe(false);
    expect(perms.allowsInvocation(user, "chat.talk")).toBe(true);
    expect(perms.allowsInvocation(user, "")).toBe(true);
  });

  it("fallback_follows_the_builtin_role_semantics", () => {
    // Nodes that used to be open to everyone without `auth` but moderator+ with it.
    const perms = Permissions.fromStrings(["discord:1"]);
    const user = inv("x", "3", {}, guildContext);
    const admin = inv("x", "2", {}, guildContext);
    admin.invoker_is_guild_admin = true;
    for (const node of [
      "voice.golive",
      "queue.manage",
      "queue.song.skip",
      "game.start",
      "stream.start",
    ]) {
      expect(perms.allowsInvocation(user, node), node).toBe(false);
      expect(perms.allowsInvocation(admin, node), node).toBe(true);
    }
    // Everyday nodes and views of settings stay open.
    for (const node of [
      "help",
      "me.profile",
      "memory.self.forget",
      "voice.join",
      "voice.mode.view",
      "channel.mode.view",
      "queue.vote",
      "queue.song.request",
    ]) {
      expect(perms.allowsInvocation(user, node), node).toBe(true);
    }
    // Changing a setting needs more than viewing it.
    expect(perms.allowsInvocation(user, "admin.channel.mode")).toBe(false);
    // The same answers as the built-in `user` / `admin` roles.
    const userRole = builtinRole("user");
    const adminRole = builtinRole("admin");
    for (const node of ["voice.golive", "queue.manage", "admin.module.toggle", "tools.mcp.x"]) {
      expect(perms.allowsInvocation(user, node)).toBe(
        granted(userRole?.grants ?? [], userRole?.denies ?? [], node),
      );
      expect(perms.allowsInvocation(admin, node)).toBe(
        granted(adminRole?.grants ?? [], adminRole?.denies ?? [], node),
      );
    }
  });

  it("builtin_roles_are_ordered_and_owner_only_nodes_stay_owner_only", () => {
    const roles = builtinRoleGrants();
    expect(roles.map((r) => r.name)).toEqual([
      "owner",
      "admin",
      "moderator",
      "trusted",
      "user",
      "restricted",
      "blocked",
    ]);
    for (const role of roles.slice(1)) {
      expect(granted(role.grants, role.denies, "owner.memory.wipe"), role.name).toBe(false);
    }
    expect(matches("queue.*", "queue")).toBe(true);
    expect(matches("queue.*", "queuex")).toBe(false);
  });

  it("members_have_the_bond_node_and_only_owners_see_her_whole_workspace", () => {
    const get = (name: string) => builtinRole(name) ?? { grants: [], denies: [] };
    for (const name of ["admin", "moderator", "trusted", "user"]) {
      expect(granted(get(name).grants, get(name).denies, WORK_BOND), name).toBe(true);
      // Her whole workspace and her own skills stay the owner's.
      expect(granted(get(name).grants, get(name).denies, WORKSPACE_ALL), name).toBe(false);
      expect(granted(get(name).grants, get(name).denies, SKILLS_MANAGE), name).toBe(false);
    }
    for (const name of ["restricted", "blocked"]) {
      expect(granted(get(name).grants, get(name).denies, WORK_BOND), name).toBe(false);
    }
    expect(granted(get("owner").grants, [], WORKSPACE_ALL)).toBe(true);
    // A plain member holds no work node itself: the bond decides (in the gate).
    for (const node of WORK_NODES) {
      expect(granted(get("user").grants, get("user").denies, node), node).toBe(false);
    }
    expect(WORK_NODES).toContain(WORK_DELEGATE);
  });

  it("authorizer_checks_accounts", () => {
    const auth = Permissions.fromStrings(["discord:1"]);
    const owner = parseAccount("discord:1");
    const user = parseAccount("discord:2");
    expect(auth.allows(owner, "owner.x")).toBe(true);
    expect(auth.allows(owner, "admin.x")).toBe(true);
    expect(auth.allows(user, "chat.react")).toBe(false);
    expect(auth.allows(user, "chat.talk")).toBe(true);
    expect(auth.allows(user, "admin.x")).toBe(false);
    expect(auth.allows(user, "owner.x")).toBe(false);
    expect(auth.allows(parseAccount("twitch:1"), "admin.x")).toBe(false);
  });

  it("owner_ids_are_platform_scoped", () => {
    const perms = Permissions.fromStrings(["twitch:1"]);
    expect(perms.isOwner(inv("x", "1").invoker)).toBe(false);
    expect(() => parseAccount("discord")).toThrow("invalid account `discord`");
    expect(() => parseAccount("discord:")).toThrow();
    expect(() => parseAccount(":1")).toThrow();
  });

  it("owners_lists_the_configured_accounts", () => {
    const perms = Permissions.fromStrings(["discord:1", " twitch:abc "]);
    expect(perms.owners()).toEqual([
      { platform: "discord", id: "1" },
      { platform: "twitch", id: "abc" },
    ]);
    perms.setOwners([{ platform: "discord", id: "7" }]);
    expect(perms.isOwner({ platform: "discord", id: "1" })).toBe(false);
    expect(perms.isOwner({ platform: "discord", id: "7" })).toBe(true);
  });
});
