import type { HarnessObserverBinding } from "./harness-observer-binding.js";
import type { HarnessValidationBinding } from "./harness-validation.js";
export interface SeatExecutionPermit {
  protocolVersion: 1;
  permitId: string;
  /** Remaining duration at response generation; clients subtract network time
   * and enforce it with a monotonic clock. Not a spending reservation. */
  validForMs: number;
  expiresAt: string;
  mode: "observed_cost";
  /** Present only after explicit observer protocol negotiation. */
  harnessObserver?: HarnessObserverBinding;
  harnessValidation?: HarnessValidationBinding;
}
