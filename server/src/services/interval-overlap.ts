type Interval = { start: number; end: number };

function mergedWithin(intervals: readonly Interval[], from: number, to: number): Interval[] {
  const sorted = intervals.map(({ start, end }) => ({ start: Math.max(from, start), end: Math.min(to, end) }))
    .filter(({ start, end }) => end > start).sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const interval of sorted) {
    const previous = result.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else result.push(interval);
  }
  return result;
}

/** Intersection of interval unions without allocating every pair of intervals. */
export function intervalOverlapMs(left: readonly Interval[], right: readonly Interval[], from: number, to: number): number {
  const a = mergedWithin(left, from, to), b = mergedWithin(right, from, to);
  let i = 0, j = 0, total = 0;
  while (i < a.length && j < b.length) {
    const l = a[i]!, r = b[j]!;
    total += Math.max(0, Math.min(l.end, r.end) - Math.max(l.start, r.start));
    if (l.end <= r.end) i++;
    else j++;
  }
  return total;
}
