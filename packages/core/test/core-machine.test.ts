// Which hosts are Core's own machine: a host whose link comes from this machine and a static
// entry at a loopback address; a host linked from elsewhere is not, and without the cluster
// module there are none.

import { ClusterKey, type ClusterService, EndpointRegistry } from "@miyoria/cluster";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { coreMachineHosts } from "../src/core-machine.js";

describe("coreMachineHosts", () => {
  it("names the hosts on Core's machine as the registry knows them now", () => {
    const services = new ServiceRegistry();
    expect(coreMachineHosts(services, "sandbox")).toEqual([]);
    const registry = new EndpointRegistry({
      static: {
        "here-sbx": { provides: ["sandbox"], url: "http://127.0.0.1:8100" },
        "lan-sbx": { provides: ["sandbox"], url: "http://192.168.1.20:8100" },
      },
    });
    services.provide("cluster", ClusterKey, { registry } as unknown as ClusterService);
    registry.setHost("this-pc", ["sandbox"]);
    registry.setLink("this-pc", { local: true });
    registry.setHost("friend-pc", ["sandbox"]);
    registry.setLink("friend-pc", { local: false });
    expect(coreMachineHosts(services, "sandbox").sort()).toEqual(["here-sbx", "this-pc"]);
  });
});
