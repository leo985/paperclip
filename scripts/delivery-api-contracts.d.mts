export const deliveryRouteFiles: readonly string[];
export function discoverDeliveryRoutes(source: string, file?: string): Array<{ method: string; path: string }>;
export function deliveryContractInventory(root: string): Array<{ method: string; path: string; source: string; body: string[]; query: string[]; errors: string[]; statuses: number[] }>;
