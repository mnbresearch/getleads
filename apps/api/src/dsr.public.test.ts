/**
 * The public buyer room (GET /v1/dsr/room/:token, routes/moat.ts).
 *
 * It used to answer every unknown link with an invented "ScaleAI" room, and a real link with
 * the whole row: the org id, the deal id, the champion's email address and the token itself.
 * A link is forwarded around a buyer's company, so what it returns is what everyone there sees.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { publicRoom } from "./routes/moat.js";

describe("public buyer room: what a link reveals", () => {
  it("returns presentation fields only", () => {
    const out = publicRoom({ id: "r", orgId: "o", dealId: "d", title: "T", shareToken: "dsr-secret", targetCompany: "Acme", status: "active", championName: "Asha", championEmail: "asha@acme.test", targetGoLiveDate: null, milestones: [], artifacts: [], viewsCount: 3, lastViewedAt: null, createdAt: new Date(), updatedAt: new Date() } as never, "Seller Co");
    expect(Object.keys(out).sort()).toEqual(["artifacts", "championName", "milestones", "preparedBy", "status", "targetCompany", "targetGoLiveDate", "title"]);
    expect(JSON.stringify(out)).not.toMatch(/asha@acme|dsr-secret|"o"|"d"/);
  });
});

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  delete process.env.PILOT_INVITE_CODE;
}
const suite = TEST_DB ? describe : describe.skip;

suite("public buyer room over HTTP", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let app: any;
  let token = "";
  beforeAll(async () => {
    const dbPkg = await import("@prospex/db");
    await dbPkg.runMigrations(TEST_DB);
    const { createApp } = await import("./app.js");
    app = createApp({ print: false } as any);
    const post = (p: string, b: unknown, h: Record<string, string> = {}) => app.fetch(new Request(`http://local${p}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }));
    const s = await (await post("/v1/auth/signup", { email: `dsr-${Date.now()}@example.com`, password: "Correct-Horse-9-Battery!", name: "Dsr Test", orgName: "Seller Co Test" })).json();
    const r = await (await post("/v1/moat/rooms", { title: "Evaluation", targetCompany: "Acme", championName: "Asha", championEmail: "asha@acme.test" }, { authorization: `Bearer ${s.token}` })).json();
    token = r.room.shareToken;
  });

  it("issues a 128-bit link and serves it without the champion's address", async () => {
    expect(token).toMatch(/^dsr-[a-f0-9]{32}$/);
    const r = await app.fetch(new Request(`http://local/v1/dsr/room/${token}`));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.room.title).toBe("Evaluation");
    expect(body.room.preparedBy).toBe("Seller Co Test");
    expect(JSON.stringify(body)).not.toMatch(/asha@acme\.test|orgId|shareToken/);
  });

  it("answers an unknown or malformed link with 404, not an invented room", async () => {
    for (const t of ["dsr-" + "0".repeat(32), "demo", "../x"]) {
      const r = await app.fetch(new Request(`http://local/v1/dsr/room/${encodeURIComponent(t)}`));
      expect(r.status, t).toBe(404);
    }
  });
});
