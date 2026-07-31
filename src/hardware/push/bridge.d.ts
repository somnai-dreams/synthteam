// Hand-written surface of bridge.js for the TypeScript side of the
// server (the .js module itself is not type-checked).
import type { AbletonPush } from "@somnai-dreams/ableton-push";

/**
 * Drives an opened Push until the hardware link fails or `signal`
 * aborts; resolves with the reason the run ended. Closing the device
 * afterwards is the caller's job.
 */
export function runPushBridge(
  push: AbletonPush,
  serverUrl: string,
  signal: AbortSignal,
): Promise<string>;
