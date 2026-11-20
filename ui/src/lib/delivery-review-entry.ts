import { matchesDeliveryWorkType, type DeliveryWorkItem, type DeliveryReviewStage } from "@paperclipai/shared";

/** Reviews enter the delivery protocol, never the ordinary coding intake channel. */
export function deliveryReviewEntryStage(item: Pick<DeliveryWorkItem, "type">): DeliveryReviewStage | undefined {
  return (["design", "coding", "test-cases"] as const).find(stage => matchesDeliveryWorkType(stage, true, item.type));
}
