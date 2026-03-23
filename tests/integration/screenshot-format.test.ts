import { describe, expect, it } from "vitest";
import {
  CAN_RUN_LIVE_INTEGRATION,
  createLiveAccount,
  submitLiveTask,
} from "./helpers.js";

const describeLive = CAN_RUN_LIVE_INTEGRATION ? describe : describe.skip;
const USE_FIRECRAWL_SOLVER = process.env.CLAWRMA_USE_FIRECRAWL_SOLVER === "1";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

function normalizeBase64(value: string): string {
  const marker = "base64,";
  const markerIndex = value.indexOf(marker);
  if (markerIndex >= 0) {
    return value.slice(markerIndex + marker.length).trim();
  }
  return value.trim();
}

describeLive("screenshot format verification (firecrawl)", () => {
  const describeFirecrawl = USE_FIRECRAWL_SOLVER ? describe : describe.skip;

  describeFirecrawl("actual image bytes from Firecrawl", () => {
    it("returns real PNG bytes", async () => {
      const { apiKey } = await createLiveAccount();
      const result = await submitLiveTask(apiKey, "screenshot", {
        url: "https://example.com",
        viewport: { width: 1280, height: 720 },
        full_page: false,
      });

      const raw =
        typeof result.image_base64 === "string" ? result.image_base64 : "";
      const imageBase64 = normalizeBase64(raw);
      expect(imageBase64.length).toBeGreaterThan(0);

      const imageBytes = Buffer.from(imageBase64, "base64");
      expect(imageBytes.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
      expect(result.format).toBe("png");
    }, 30_000);

    it("viewport dimensions are respected in the response", async () => {
      const { apiKey } = await createLiveAccount();
      const result = await submitLiveTask(apiKey, "screenshot", {
        url: "https://example.com",
        viewport: { width: 800, height: 600 },
        full_page: false,
      });

      expect(result.viewport).toEqual({ width: 800, height: 600 });

      const raw =
        typeof result.image_base64 === "string" ? result.image_base64 : "";
      const imageBase64 = normalizeBase64(raw);
      expect(imageBase64.length).toBeGreaterThan(0);
    }, 30_000);
  });
});
