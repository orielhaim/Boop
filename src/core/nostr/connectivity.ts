export type NetworkRoute = {
  connected: boolean;
  type?: string;
};

export function connectivityRestored(
  previous: NetworkRoute | undefined,
  next: NetworkRoute,
) {
  if (!previous || !next.connected) return false;
  if (!previous.connected) return true;
  return Boolean(
    previous.type &&
    previous.type !== "UNKNOWN" &&
    next.type &&
    next.type !== "UNKNOWN" &&
    previous.type !== next.type,
  );
}
