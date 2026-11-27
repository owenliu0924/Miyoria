// Offering the browser's tools only while a computer can run them: the sandbox is on the cluster
// (a browser never runs on Core's machine), some computer answers, and one of them has the
// browser image. `SandboxGate`'s `extraAvailable` hook is read once when the sandbox's tools are
// offered, so it cannot follow the image being built later or going away; this follows every
// recheck of the module instead (and the computers changing). The reason they are not offered
// is kept for the status lines and the log, and a call that arrives in between still answers
// with it (`Browse.availability` in each tool).

import type { Capability } from "@miyoria/gate/actions";
import { getLogger } from "@miyoria/runtime/kernel";
import type { SandboxFeatures } from "../types.js";
import type { Browse } from "./capabilities.js";

const log = getLogger("sandbox.browse");

/** What `register` returns: the undo. */
export interface CapabilityRegistrar {
  register(capability: Capability): () => void;
}

export class BrowseOffer {
  readonly #registry: CapabilityRegistrar;
  readonly #browse: Browse;
  #unregister: (() => void)[] = [];
  #reason: string | null = "還沒檢查過沙箱";
  #closed = false;

  constructor(registry: CapabilityRegistrar, browse: Browse) {
    this.#registry = registry;
    this.#browse = browse;
  }

  /** Whether the tools are offered now. */
  get offered(): boolean {
    return this.#unregister.length > 0;
  }

  /** Why they are not offered (her words), `null` while they are. */
  get reason(): string | null {
    return this.#reason;
  }

  /**
   * After each check of the sandbox: offers the tools when a browser can run, withdraws them
   * (and says why in the log) when it cannot.
   */
  update(sandbox: { available: boolean; features: SandboxFeatures }): void {
    if (this.#closed) return;
    let reason: string | null;
    if (!sandbox.available) reason = "沒有能用的沙箱";
    else if (sandbox.features.where !== "cluster") {
      reason = "瀏覽器只在叢集裡跑沙箱服務的電腦上開,這台的 Docker 不開瀏覽器";
    } else {
      const can = this.#browse.availability();
      reason = can.ok ? null : can.reason;
    }
    if (reason === null && !this.offered) {
      for (const capability of this.#browse.capabilities) {
        this.#unregister.push(this.#registry.register(capability));
      }
      log.info("a computer can run the browser: browse_* are offered");
    } else if (reason !== null && this.offered) {
      this.#withdraw();
      log.warn({ reason }, "no computer can run the browser: browse_* are withdrawn");
    }
    this.#reason = reason;
  }

  /** The status line, with why the tools are not offered when they are not. */
  statusLine(): string {
    const line = this.#browse.statusLine();
    return this.#reason === null || this.offered ? line : `${line};工具未開放:${this.#reason}`;
  }

  #withdraw(): void {
    for (const unregister of this.#unregister) unregister();
    this.#unregister = [];
  }

  /** Withdraws the tools and closes every session (module stop). */
  async close(): Promise<void> {
    this.#closed = true;
    this.#withdraw();
    await this.#browse.close();
  }
}
