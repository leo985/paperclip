import { describe, expect, it } from "vitest";
import { BUILTIN_DELIVERY_TEMPLATE, deliveryTemplateDefinitionSchema } from "./delivery-templates.js";
describe("delivery entry check configuration",()=>{
  it("accepts legacy templates and selected conditions",()=>{
    const definition=structuredClone(BUILTIN_DELIVERY_TEMPLATE.definition);
    definition.stages.design.entryChecks=["title"];
    expect(deliveryTemplateDefinitionSchema.parse(definition).stages.design.entryChecks).toEqual(["title"]);
    delete definition.stages.design.entryChecks;
    expect(deliveryTemplateDefinitionSchema.safeParse(definition).success).toBe(true);
  });
  it.each([[],["unknown"],["title","title"]].map(checks=>({checks})))("rejects empty, unknown or duplicated rules %j",({checks})=>{
    const definition=structuredClone(BUILTIN_DELIVERY_TEMPLATE.definition);
    Object.assign(definition.stages.design,{entryChecks:checks});
    expect(deliveryTemplateDefinitionSchema.safeParse(definition).success).toBe(false);
  });
});
