import { expect, it } from "vitest";
import { managedManifestSchema } from "./managed-sessions.js";
it("accepts optional input provenance while preserving old client manifests", () => {
  const old = { contentId: "id", revision: "revision", kind: "user", parentStreamId: null, messageId: "id", toolCallId: null,
    name: null, mime: null, parts: 1, bytes: 2, sha256: "a".repeat(64), redacted: false, sourceTruncated: false, unavailableReason: null };
  expect(managedManifestSchema.safeParse(old).success).toBe(true);
  for (const inputSource of ["harness", "manual", "unknown"]) expect(managedManifestSchema.parse({ ...old, inputSource }).inputSource).toBe(inputSource);
  expect(managedManifestSchema.safeParse({ ...old, inputSource: "anything" }).success).toBe(false);
});
