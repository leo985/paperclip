import { heartbeatService } from "../services/heartbeat.js";
import { Router } from "express";
import { z } from "zod";
import { harnessValidationAuthorizationSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager } from "./dsp7-seat-owners.js";
import { badRequest, forbidden } from "../errors.js";
import { harnessValidationService } from "../services/harness-validation.js";

/** Authorization is separate from explicit native dispatch. */
export function harnessValidationRoutes(db: Db) {
  const router = Router();
  const path = "/companies/:companyId/dsp7-seats/:id/harness-validation/:taskId";
  function scope(req: Parameters<typeof assertBoard>[0]) {
    const parsed = z.object({ companyId: z.string().uuid(), id: z.string().uuid(), taskId: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) throw badRequest("隔离验证范围编号无效");
    const value = parsed.data;
    assertBoard(req); assertCompanyAccess(req, value.companyId);
    if (!isSeatManager(req, value.companyId)) throw forbidden("只有组织管理员可授权隔离验证");
    return { companyId: value.companyId, seatId: value.id, taskId: value.taskId };
  }
  router.post(path, async (req, res) => {
    const input = scope(req), parsed = harnessValidationAuthorizationSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("隔离验证授权参数无效");
    const authorization = await harnessValidationService(db).authorize(input, parsed.data.dispatchId,
      parsed.data.expectedBundleDigest, req.actor.userId ?? "local-board");
    res.setHeader("Cache-Control", "no-store");
    res.json({ authorization, dispatched: false, executionStarted: false });
  });
  router.post(path + "/:dispatchId/dispatch", async (req, res) => {
    const input = scope(req), parsed = z.string().uuid().safeParse(req.params.dispatchId);
    if (!parsed.success || Object.keys(req.body ?? {}).length) throw badRequest("隔离验证派发参数无效");
    const result = await harnessValidationService(db).dispatch(input, parsed.data, req.actor.userId ?? "local-board",
      heartbeatService(db).wakeup);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });
  router.delete(path + "/:dispatchId", async (req, res) => {
    const input = scope(req), parsed = z.string().uuid().safeParse(req.params.dispatchId);
    if (!parsed.success) throw badRequest("隔离验证授权编号无效");
    res.setHeader("Cache-Control", "no-store");
    res.json(await harnessValidationService(db).revoke(input, parsed.data, req.actor.userId ?? "local-board"));
  });
  return router;
}
