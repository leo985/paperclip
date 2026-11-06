export interface SeatExecutionPermit {
  protocolVersion: 1;
  permitId: string;
  /** Remaining duration at response generation; clients subtract network time
   * and enforce it with a monotonic clock. Not a spending reservation. */
  validForMs: number;
  expiresAt: string;
  mode: "observed_cost";
}
