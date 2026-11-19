const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function botWriteFeedback(feedback: readonly unknown[]) {
  return feedback
    .filter(object)
    .filter((row) => ["order", "batch"].includes(String(row.tool)));
}
export function botNeedsAnalysis(feedback: readonly unknown[]): boolean {
  const writes = botWriteFeedback(feedback);
  return (
    writes.length === 0 ||
    writes.every(
      (row) =>
        typeof row.summary === "string" &&
        row.summary.startsWith("本地内部调动"),
    )
  );
}
export function acceptedInternalWrites(
  writes: readonly Record<string, unknown>[],
): boolean {
  return writes.every((row) => {
    if (!object(row.result)) return false;
    if (row.tool === "batch")
      return (
        Array.isArray(row.result.results) &&
        row.result.results.length > 0 &&
        row.result.results.every((r) => object(r) && r.status === "accepted")
      );
    return (
      row.result.status === "accepted" ||
      (object(row.result.commandReceipt) &&
        row.result.commandReceipt.status === "accepted")
    );
  });
}
