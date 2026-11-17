import { z } from "zod";
import { managedIdentitySchema } from "./managed-sessions.js";
const id=z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const packageSchema=z.object({id,version:z.string().max(32).regex(/^\d+\.\d+\.\d+$/),layer:z.enum(["L3","L4"]),
  manifestDigest:digest,skills:z.array(id).max(100)}).strict();
/** Discovery only: this protocol must never be accepted as an execution route. */
export const harnessBundleInputSchema=z.object({
  protocolVersion:z.literal(1),bundleDigest:digest,project:id,
  packages:z.array(packageSchema).length(2),mode:z.literal("candidate"),
}).strict().superRefine((value,ctx)=>{
  const skills=value.packages.flatMap(p=>p.skills);
  if(new Set(value.packages.map(p=>p.layer)).size!==2 || new Set(value.packages.map(p=>p.id)).size!==2 || new Set(skills).size!==skills.length) {
    ctx.addIssue({code:"custom",message:"Bundle package or skill conflict"});
  }
});
export const harnessBundleRegistrationSchema=managedIdentitySchema.extend({
  expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),bundle:harnessBundleInputSchema,
}).strict();
export type HarnessBundleInput=z.infer<typeof harnessBundleInputSchema>;
export interface HarnessBundleRecord extends HarnessBundleInput {
  checkedAt:string;validation:"seat-reported-local-files";executionReady:false;loadState:"unconfirmed";
}
export interface HarnessBundleRegistry { version:1;revision:number;items:HarnessBundleRecord[] }
export interface HarnessBundleRegistryResponse extends HarnessBundleRegistry { registrationSupported:boolean }
