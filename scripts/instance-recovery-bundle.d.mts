export interface RecoveryBundleInput {
  components: Record<string, string> & { database: string; config: string; masterKey: string; artifacts: string; runLogs: string };
  destination: string;
  quiesced: boolean;
}
export function createRecoveryBundle(input: RecoveryBundleInput): Promise<unknown>;
export function verifyRecoveryBundle(bundle: string): Promise<unknown>;
export function restoreRecoveryBundle(bundle: string, destination: string): Promise<void>;
