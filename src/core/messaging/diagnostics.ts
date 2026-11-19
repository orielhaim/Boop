export function messagingMetric(
  event: string,
  fields: Record<string, boolean | number>,
) {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.debug(`Messaging: ${event}`, fields);
  }
}
