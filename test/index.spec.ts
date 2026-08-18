import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("TRP Worker", () => {
  it("serves a healthy status when bindings and migrations are ready", async () => {
    const response = await SELF.fetch("https://example.test/health");
    const body = await response.json<{ ok: boolean; database: string }>();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.database).toBe("ok");
  });

  it("rejects Telegram updates without the webhook secret", async () => {
    const response = await SELF.fetch("https://example.test/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(response.status).toBe(401);
  });
});
