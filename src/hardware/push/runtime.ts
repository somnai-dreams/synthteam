import { AbletonPush } from "@somnai-dreams/ableton-push";
import { runPushBridge } from "./bridge.js";

export type PushConnectionState =
  | { kind: "disconnected"; message: string }
  | { kind: "connected" };

const RETRY_DELAY_MS = 2_000;

/**
 * Owns the Push 3 hardware link for the server process, mirroring
 * Uf8Runtime: keep trying to open the device, hand it to
 * runPushBridge while it lives, and go back to retrying when the
 * link drops. The bridge itself talks to the game over the server's
 * own WebSocket, so the rest of the server treats it exactly like
 * the old external process.
 */
export class PushRuntime {
  readonly #serverUrl: string;
  #state: PushConnectionState = {
    kind: "disconnected",
    message: "Starting Push bridge…",
  };
  #abort: AbortController | null = null;
  #runPromise: Promise<void> | null = null;
  #stopping = false;

  constructor(serverUrl: string) {
    this.#serverUrl = serverUrl;
  }

  get state(): PushConnectionState {
    return this.#state;
  }

  start(): void {
    if (this.#runPromise !== null) {
      return;
    }
    this.#stopping = false;
    this.#runPromise = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#abort?.abort();
    await this.#runPromise;
    this.#runPromise = null;
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      let push: AbletonPush | null = null;
      try {
        push = await AbletonPush.open({ model: "push3" });
      } catch (error) {
        this.#state = {
          kind: "disconnected",
          message: `Push unavailable — ${errorMessage(error)}`,
        };
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }
      this.#abort = new AbortController();
      this.#state = { kind: "connected" };
      try {
        const reason = await runPushBridge(
          push,
          this.#serverUrl,
          this.#abort.signal,
        );
        this.#state = { kind: "disconnected", message: reason };
      } catch (error) {
        this.#state = {
          kind: "disconnected",
          message: `Push bridge crashed — ${errorMessage(error)}`,
        };
      } finally {
        this.#abort = null;
        try {
          await push.close();
        } catch {
          // the hardware may already be gone
        }
      }
      if (!this.#stopping) {
        await Bun.sleep(RETRY_DELAY_MS);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown controller error";
}
