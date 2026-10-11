import { useEffect, useState } from "react";

const STEP = 5 * 60_000;
const rounded = () => Math.ceil(Date.now() / STEP) * STEP;

/**
 * "Now", rounded up to 5 minutes, so query keys that end at now stay stable
 * between renders and only roll over (refetching) every few minutes.
 */
export function useNow(): number {
  const [now, setNow] = useState(rounded);
  useEffect(() => {
    const id = setInterval(() => setNow(rounded()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
