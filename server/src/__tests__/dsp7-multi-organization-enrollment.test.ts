import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { dsp7QuickSeatRoutes } from "../routes/dsp7-quick-seats.js";

const invitationId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64);
function fixture(options: { expired?: boolean; absent?: boolean } = {}) {
  const invitation = { companyId, details: { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + (options.expired ? -60000 : 60000)).toISOString(), userId: "private-owner" } };
  const rows = [options.absent ? [] : [invitation], [{ name: "基础平台" }]];
  const select = vi.fn(() => {
    const result = rows.shift() ?? [];
    const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve(result), then: (resolve: any) => Promise.resolve(result).then(resolve) };
    return chain;
  });
  const db = { select, insert: vi.fn(), transaction: vi.fn() } as any;
  const router = dsp7QuickSeatRoutes(db);
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === "/dsp7-quick-enroll/inspect");
  const handle = layer.route.stack[0].handle;
  const res = { setHeader: vi.fn(), json: vi.fn() };
  return { handle, res, db };
}
describe("multi-organization invitation inspection", () => {
  it("reveals only the verified target organization without consuming or creating a seat", async () => {
    const { handle, res, db } = fixture();
    await handle({ body: { invitationId, token } }, res);
    expect(res.json).toHaveBeenCalledWith({ companyId, companyName: "基础平台" });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each([{ expired: true }, { absent: true }, {}])("rejects expired, unknown or wrong-token invitations %j", async options => {
    const { handle, res } = fixture(options);
    await expect(handle({ body: { invitationId, token: options.expired || options.absent ? token : "b".repeat(64) } }, res)).rejects.toThrow("邀请无效或过期");
    expect(res.json).not.toHaveBeenCalled();
  });
  it("rejects untrusted target organization overrides", async () => {
    const { handle, res } = fixture();
    await expect(handle({ body: { invitationId, token, companyId } }, res)).rejects.toThrow("邀请格式无效");
  });
});
