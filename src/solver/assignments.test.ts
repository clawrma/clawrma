import { describe, expect, it } from "vitest";
import {
  extractWebSocketErrorMessage,
  normalizeFulfillmentPath,
  parseAssignedCapability,
  parseAssignedFulfillmentPath,
  parseAssignedTaskType,
  parseTaskAssignment,
  summarizeInvalidTaskAssignment,
} from "./assignments.js";
import type { TaskAssignment } from "./contracts.js";

function makeExtensibleTaskAssignment(): TaskAssignment {
  return {
    type: "task_assignment",
    task_id: "task_search_1",
    task_type: "web_search",
    payload: { query: "assigned dispatch" },
    capability: {
      task_type: "web_search",
      fulfillment_path: "api",
      provider_name: "provider-a",
      model_name: "search-a",
    },
  };
}

describe("solver assignment parsing", () => {
  it("parses valid task assignments into the normalized runtime shape", () => {
    expect(
      parseTaskAssignment({
        type: "task_assignment",
        task_id: "task_search_1",
        task_type: "web_search",
        payload: { query: "assigned dispatch" },
        capability: {
          task_type: "web_search",
          fulfillment_path: "api",
          provider_name: "provider-a",
          model_name: "search-a",
        },
      }),
    ).toEqual(makeExtensibleTaskAssignment());
  });

  it("returns null for malformed task-assignment envelopes", () => {
    expect(
      parseTaskAssignment({
        type: "task_assignment",
        task_id: "",
        task_type: "llm_inference",
      }),
    ).toBeNull();

    expect(
      parseTaskAssignment({
        type: "task_complete",
        task_id: "task_search_1",
      }),
    ).toBeNull();
  });

  it("summarizes malformed assignments without exposing payload contents", () => {
    const summary = summarizeInvalidTaskAssignment({
      type: "task_assignment",
      task_id: "",
      task_type: "llm_inference",
      payload: {
        apiKey: "cr_sk_secret",
      },
    });

    expect(summary).toEqual({
      taskIdPresent: false,
      taskIdType: "string",
      taskType: "llm_inference",
      hasPayload: true,
      hasCapability: false,
    });
    expect(summary).not.toHaveProperty("payload");
    expect(JSON.stringify(summary)).not.toContain("cr_sk_secret");
  });

  it("parses extensible assigned capabilities and trims provider metadata", () => {
    const assignment: TaskAssignment = {
      ...makeExtensibleTaskAssignment(),
      capability: {
        task_type: "web_search",
        fulfillment_path: "api",
        provider_name: " provider-a ",
        model_name: " search-a ",
      },
    };

    expect(parseAssignedCapability(assignment, "web_search")).toEqual({
      task_type: "web_search",
      fulfillment_path: "api",
      provider_name: "provider-a",
      model_name: "search-a",
    });
  });

  it("reports missing capability metadata with the current solver wording", () => {
    expect(
      parseAssignedCapability(
        {
          ...makeExtensibleTaskAssignment(),
          capability: {
            task_type: "web_search",
            fulfillment_path: "api",
            model_name: "search-a",
          },
        },
        "web_search",
      ),
    ).toBe(
      "Task assignment missing capability.provider_name for 'web_search'.",
    );

    expect(
      parseAssignedCapability(
        {
          ...makeExtensibleTaskAssignment(),
          capability: {
            task_type: "web_search",
            fulfillment_path: "api",
            provider_name: "provider-a",
          },
        },
        "web_search",
      ),
    ).toBe("Task assignment missing capability.model_name for 'web_search'.");

    expect(
      parseAssignedCapability(
        {
          ...makeExtensibleTaskAssignment(),
          capability: {
            task_type: "web_search",
            provider_name: "provider-a",
            model_name: "search-a",
          },
        },
        "web_search",
      ),
    ).toBe(
      "Task assignment missing valid capability.fulfillment_path for 'web_search'.",
    );
  });

  it("reports task-type mismatch and missing task-type errors clearly", () => {
    expect(parseAssignedTaskType("screenshot", "web_search")).toEqual({
      ok: false,
      error:
        "Task assignment capability.task_type 'screenshot' does not match task_type 'web_search'.",
    });

    expect(parseAssignedTaskType(undefined, "web_search")).toEqual({
      ok: false,
      error: "Task assignment missing capability.task_type for 'web_search'.",
    });

    expect(parseAssignedTaskType("proxy_fetch", "web_search")).toEqual({
      ok: false,
      error:
        "Task assignment missing valid capability.task_type for 'web_search'.",
    });
  });

  it("validates assigned fulfillment paths and defaults invalid general paths to api", () => {
    expect(parseAssignedFulfillmentPath("api")).toBe("api");
    expect(parseAssignedFulfillmentPath("cli")).toBe("cli");
    expect(parseAssignedFulfillmentPath("cli_codex")).toBe("cli_codex");
    expect(parseAssignedFulfillmentPath("desktop")).toBeNull();

    expect(normalizeFulfillmentPath("cli")).toBe("cli");
    expect(normalizeFulfillmentPath("desktop")).toBe("api");
    expect(normalizeFulfillmentPath(undefined)).toBe("api");
  });

  it("extracts websocket error strings and falls back when absent", () => {
    expect(
      extractWebSocketErrorMessage({
        type: "error",
        error: "  upstream_failure  ",
      }),
    ).toBe("upstream_failure");

    expect(
      extractWebSocketErrorMessage({
        type: "error",
      }),
    ).toBe("unknown_error");
  });
});
