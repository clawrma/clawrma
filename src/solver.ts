export type {
  SolverHandle,
  SolverRuntimeDependencies,
} from "./solver/runtime.js";
export {
  registerCapabilitiesHttpFallback,
  startSolver,
} from "./solver/runtime.js";

export { buildSolverCapabilities } from "./solver/capabilities.js";
export { createIdleDetector } from "./solver/idle.js";
export type { IdleDetector, IdleDetectorOptions } from "./solver/idle.js";
export { isInScheduleWindow } from "./solver/schedule.js";
export {
  reconfigureSolver,
  startSolverIntake,
  stopSolverIntake,
} from "./solver/control.js";
export type {
  SolverConfigOptions,
  SolverConfigPrompter,
  SolverControlOptions,
} from "./solver/control.js";
