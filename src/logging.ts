import pino from "pino";
import { join } from "node:path";
import { LOG_DIR } from "./constants.js";

const logPath = join(LOG_DIR, "solver.log");
const logLevel = process.env.CLAWRMA_LOG_LEVEL ?? "info";

const destination = pino.destination({
  dest: logPath,
  mkdir: true,
  sync: false,
});

export const baseLogger = pino({ level: logLevel }, destination);
export const wsLogger = baseLogger.child({ component: "ws" });
export const solverLogger = baseLogger.child({ component: "solver" });
export const setupLogger = baseLogger.child({ component: "setup" });
export const clientLogger = baseLogger.child({ component: "client" });
export const notifyLogger = baseLogger.child({ component: "notify" });
