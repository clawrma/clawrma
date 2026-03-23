import type {
  ScreenshotTaskPayload,
  ScreenshotTaskResult,
  SolverCapability,
} from "../types.js";

/**
 * Context used to detect whether a local browser fulfiller is runnable.
 */
export interface BrowserDetectContext {
  playwrightAvailable: boolean;
}

/**
 * Shared runtime context for browser-style task fulfillers.
 */
export interface BrowserFulfillContext {
  fetchImpl: typeof fetch;
  fetchTimeoutMs: number;
}

/**
 * Contract for a concrete screenshot fulfiller implementation.
 */
export interface ScreenshotFulfiller {
  detect(context: BrowserDetectContext): SolverCapability | null;
  fulfill(
    payload: ScreenshotTaskPayload,
    context: BrowserFulfillContext,
  ): Promise<ScreenshotTaskResult>;
}

/**
 * Add screenshot built-ins here in future PRs. Tests can inject browser
 * fulfillers through the solver runtime's internal fulfiller seam.
 */
export const defaultScreenshotFulfillers: ScreenshotFulfiller[] = [];
