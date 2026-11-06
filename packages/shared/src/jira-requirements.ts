export type JiraRequirementMode = "development" | "human-review" | "harness-linked" | "qa" | "unmapped";
export interface JiraRequirementPerson { login: string; name: string; email: string | null }
export interface JiraRequirementItem {
  key: string; summary: string; issueType: string; status: string; done: boolean;
  assignee: JiraRequirementPerson | null; mode: JiraRequirementMode; skill: string | null; note: string;
  userId: string | null; seats: Array<{ id: string; name: string }>;
}
export interface JiraRequirementPreview {
  key: string; summary: string; status: string; done: boolean;
  owner: JiraRequirementPerson | null; ownerField: string; ownerUserId: string | null;
  children: JiraRequirementItem[]; fingerprint: string; jiraBaseUrl: string;
  members: Array<{ id: string; name: string; email: string }>;
}

// Descriptions are editable. Treat embedded metadata as untrusted input in every consumer.
import { z } from "zod";
const jiraKey = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);
const person = z.object({ login: z.string().min(1), name: z.string(), email: z.string().nullable() });
const mode = z.enum(["development", "human-review", "harness-linked", "qa", "unmapped"]);
const item = z.object({ key: jiraKey, summary: z.string(), issueType: z.string(), status: z.string(), done: z.boolean(), assignee: person.nullable(), mode, skill: z.string().nullable(), note: z.string(), userId: z.string().nullable(), seats: z.array(z.object({ id: z.string(), name: z.string() })) });
const jiraBaseUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
const common = { version: z.literal(1), jiraBaseUrl, connectionSeatId: z.string().min(1) };
const rootMetadata = z.object({ ...common, key: jiraKey, summary: z.string(), owner: person.nullable(), ownerUserId: z.string(), children: z.array(item).max(1000) });
const childMetadata = item.extend({ ...common, rootKey: jiraKey });
export type JiraRequirementRootMetadata = z.infer<typeof rootMetadata>;
export type JiraRequirementChildMetadata = z.infer<typeof childMetadata>;
export function readJiraRequirementMetadata(description?: string | null): JiraRequirementRootMetadata | JiraRequirementChildMetadata | null {
  try {
    const matches = [...(description ?? "").matchAll(/<!-- DSP7-REQUIREMENT (.*?) -->/g)];
    if (matches.length !== 1) return null;
    const raw = JSON.parse(matches[0][1]);
    const parsed = (Object.hasOwn(raw, "rootKey") ? childMetadata : rootMetadata).safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
