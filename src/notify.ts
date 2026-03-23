import { execFile } from "node:child_process";
import { notifyLogger } from "./logging.js";
import type { ClawrmaConfig } from "./types.js";

const NOTIFICATION_TIMEOUT_MS = 10_000;

export async function sendNotification(
  config: ClawrmaConfig,
  message: string,
): Promise<void> {
  if (config.framework === "none") {
    return;
  }

  const channel = config.notifications.channel;
  if (!channel) {
    return;
  }

  const target = config.notifications.target;

  try {
    await execFilePromise(
      "openclaw",
      [
        "message",
        "send",
        "--channel",
        channel,
        "--target",
        target,
        "--message",
        message,
        "--json",
      ],
      { timeout: NOTIFICATION_TIMEOUT_MS },
    );
  } catch (error: unknown) {
    notifyLogger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        channel,
        target,
      },
      "notification_send_failed",
    );
  }
}

function execFilePromise(
  command: string,
  args: string[],
  options: { timeout: number },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, options, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
