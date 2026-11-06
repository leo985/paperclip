import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db, agents } from "@paperclipai/db";
import { resolveSeatGroupOwner, sendSeatGroupMessage } from "./seat-group-notifications.js";
import { seatDingtalkTargetSchema, seatGroupCredentialsSchema } from "@paperclipai/shared";

const credentials = { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=private-group-token", signingSecret: "SEC0123456789abcdef" };
const owner = { externalId: "ding-owner-123", name: "席位负责人" };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("signed seat group notifications", () => {
  it("signs the official webhook and uses a real user-ID mention without @all", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errcode: 0 })));
    vi.stubGlobal("fetch", fetcher);
    expect(await sendSeatGroupMessage(credentials, owner, "待处理任务")).toEqual({ status: "submitted", code: "GROUP_ACCEPTED_NOT_READ" });
    const [destination, request] = fetcher.mock.calls[0];
    const url = new URL(destination);
    expect(url.origin).toBe("https://oapi.dingtalk.com");
    expect(url.searchParams.get("sign")).toBe(createHmac("sha256", credentials.signingSecret).update(`1700000000000\n${credentials.signingSecret}`).digest("base64"));
    expect(JSON.parse(request.body)).toEqual({ msgtype: "text", text: { content: "待处理任务\n@ding-owner-123" }, at: { atUserIds: ["ding-owner-123"], isAtAll: false } });
    expect(request.redirect).toBe("error");
  });
  it.each([
    "http://oapi.dingtalk.com/robot/send?access_token=x",
    "https://attacker.test/robot/send?access_token=x",
    "https://oapi.dingtalk.com/other?access_token=x",
    "https://oapi.dingtalk.com/robot/send?access_token=x&access_token=y",
    "https://oapi.dingtalk.com/robot/send?access_token=x&extra=y",
    "not a URL",
  ])("rejects untrusted destinations without network I/O: %s", async webhookUrl => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(seatGroupCredentialsSchema.safeParse({ ...credentials, webhookUrl }).success).toBe(false);
    expect((await sendSeatGroupMessage({ ...credentials, webhookUrl }, owner, "pending")).status).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires an enterprise bot for group targets and keeps legacy personal targets valid", () => {
    expect(seatDingtalkTargetSchema.safeParse({ userId: "owner", profile: "corp:user" }).success).toBe(true);
    expect(seatDingtalkTargetSchema.safeParse({ userId: "owner", profile: "corp:user", groupId: "bc4998cb-b33f-43d1-8fb7-52e397b7dfab" }).success).toBe(false);
  });
  it.each([
    [new Response(JSON.stringify({ errcode: 310000 })), "failed"],
    [new Response("{}"), "unknown"],
    [new Response("{}", { status: 500 }), "unknown"],
  ])("does not label rejected or ambiguous responses as submitted", async (response, status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect((await sendSeatGroupMessage(credentials, owner, "pending")).status).toBe(status);
  });
  it("does not retry an unknown outcome or expose credential-bearing errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(credentials.webhookUrl)); vi.stubGlobal("fetch", fetcher);
    const result = await sendSeatGroupMessage(credentials, owner, "pending");
    expect(result).toEqual({ status: "unknown", code: "GROUP_NETWORK_OR_RESPONSE_UNKNOWN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private-group-token");
  });
});
describe("seat owner identity for group mentions", () => {
  function fixture(people: Array<{ externalId: string; name: string }>) {
    let predicate: ReturnType<PgDialect["sqlToQuery"]>;
    const chain: Record<string, unknown> = { then: (ok: (value: unknown) => unknown) => Promise.resolve(people).then(ok) };
    for (const method of ["from", "innerJoin"]) chain[method] = () => chain;
    chain.where = (condition: any) => { predicate = new PgDialect().sqlToQuery(condition); return chain; };
    return { db: { select: () => chain } as unknown as Db, query: () => predicate };
  }
  const agent = { adapterConfig: { dsp7Seat: { ownerUserId: "platform-owner" } } } as unknown as typeof agents.$inferSelect;
  it("uses linked user identity within the bot enterprise and enabled active directory", async () => {
    const f = fixture([owner, owner]);
    expect(await resolveSeatGroupOwner(f.db, agent, "bot-corp")).toEqual(owner);
    expect(f.query().params).toEqual(expect.arrayContaining(["platform-owner", "bot-corp", "DingTalk", true]));
    expect(f.query().sql).toContain('"personnel_people"."user_id"');
    expect(f.query().sql).not.toContain('"personnel_people"."company_id"');
  });
  it.each([{ people: [] }, { people: [owner, { externalId: "another-user", name: owner.name }] }])("rejects absent or ambiguous identity instead of guessing by name", async ({ people }) => {
    await expect(resolveSeatGroupOwner(fixture(people).db, agent, "corp")).rejects.toThrow("未唯一关联");
  });
});
