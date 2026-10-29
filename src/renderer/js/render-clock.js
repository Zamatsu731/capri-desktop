// Keep the display clock's phase instead of discarding the remainder at every draw.
// This avoids a 60 fps target falling to 48 fps on a 144 Hz monitor.
export function renderTime(now, previous, interval) {
  const elapsed = now - previous;
  if (elapsed < interval - 0.5) return null;
  return elapsed >= interval ? now - elapsed % interval : now;
}
