export type ReadinessCheck = () => Promise<void>;

/** Shares one in-flight dependency probe without caching its result. */
export function coalesceReadinessCheck(check: ReadinessCheck): ReadinessCheck {
  let inFlight: Promise<void> | null = null;

  return () => {
    if (inFlight) return inFlight;

    const current = Promise.resolve().then(check);
    inFlight = current;
    void current.then(
      () => {
        if (inFlight === current) inFlight = null;
      },
      () => {
        if (inFlight === current) inFlight = null;
      },
    );
    return current;
  };
}
