import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  createLiveAccount,
  submitLiveTask,
  withLiveSolver,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const USE_FIRECRAWL_SOLVER = process.env.CLAWRMA_USE_FIRECRAWL_SOLVER === "1";

function normalizeBase64(value: string): string {
  const marker = "base64,";
  const markerIndex = value.indexOf(marker);
  if (markerIndex >= 0) {
    return value.slice(markerIndex + marker.length).trim();
  }
  return value.trim();
}

describeLive("integration screenshot", () => {
  it("submits screenshot and receives base64 image payload", async () => {
    if (USE_FIRECRAWL_SOLVER) {
      const { apiKey } = await createLiveAccount();
      const result = await submitLiveTask(apiKey, "screenshot", {
        url: "https://example.com",
        viewport: { width: 1280, height: 720 },
        full_page: false,
      });

      const rawImage =
        typeof result.image_base64 === "string" ? result.image_base64 : "";
      const imageBase64 = normalizeBase64(rawImage);
      expect(imageBase64.length).toBeGreaterThan(0);
      const imageBytes = Buffer.from(imageBase64, "base64");
      expect(imageBytes.byteLength).toBeGreaterThan(0);
      return;
    }

    const onePixelPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBAp0fvwAAAABJRU5ErkJggg==";

    await withLiveSolver(
      {
        capabilities: [{ taskType: "screenshot" }],
        onTaskAssignment: ({ payload }) => {
          const targetUrl =
            typeof payload.url === "string"
              ? payload.url
              : "https://example.com";
          return {
            result: {
              image_base64: onePixelPngBase64,
              format: "png",
              url: targetUrl,
              viewport: { width: 1280, height: 720 },
            },
          };
        },
      },
      async () => {
        const { apiKey } = await createLiveAccount();
        const result = await submitLiveTask(apiKey, "screenshot", {
          url: "https://example.com",
          viewport: { width: 1280, height: 720 },
          full_page: false,
        });

        const rawImage =
          typeof result.image_base64 === "string" ? result.image_base64 : "";
        const imageBase64 = normalizeBase64(rawImage);
        expect(imageBase64.length).toBeGreaterThan(0);

        const imageBytes = Buffer.from(imageBase64, "base64");
        expect(imageBytes.byteLength).toBeGreaterThan(0);
      },
    );
  }, 30_000);
});
