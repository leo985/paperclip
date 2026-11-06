/** Keep operational guidance readable while retaining the full diagnostic ID. */
export function executionMessage(message?: string | null) {
  const match = message?.match(/\s*运行编号[：:]\s*([a-f0-9-]{36})/i);
  return { text: match ? message!.replace(match[0], "").trim() : message, runId: match?.[1] };
}
