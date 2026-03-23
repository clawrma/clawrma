import type {
  PageSnapshotTaskPayload,
  PageSnapshotTaskResult,
  SolverCapability,
} from "../types.js";
import type {
  BrowserDetectContext,
  BrowserFulfillContext,
} from "./screenshot.js";

/**
 * Contract for a concrete page-snapshot fulfiller implementation.
 */
export interface PageSnapshotFulfiller {
  detect(context: BrowserDetectContext): SolverCapability | null;
  fulfill(
    payload: PageSnapshotTaskPayload,
    context: BrowserFulfillContext,
  ): Promise<PageSnapshotTaskResult>;
}

/**
 * Default runnable page-snapshot fulfillers shipped in the package.
 */
export const defaultPageSnapshotFulfillers: PageSnapshotFulfiller[] = [];
