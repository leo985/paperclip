import { expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { repairJiraClient } from "./delivery-repair-jira.js";

it("rejects the retired Jira creation path before any external request", async () => {
  const fetcher = vi.fn();vi.stubGlobal("fetch", fetcher);
  try {
    await expect(repairJiraClient({} as Db, "company", "project")).rejects.toThrow("已停用");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
