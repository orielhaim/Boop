export function externalMessageUrl(value: string, type: string) {
  if (value.length > 4096 || /[\s\p{Cc}\\]/u.test(value)) return;
  if (type === "email") {
    const match =
      /^mailto:([a-z0-9][a-z0-9._%+-]{0,63})@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/iu.exec(
        value,
      );
    if (match && !match[1].endsWith(".") && !match[1].includes(".."))
      return `mailto:${encodeURIComponent(match[1])}@${match[2]}`;
    return;
  }
  if (type === "phone") {
    const number = /^tel:(\+?[0-9]{7,17})$/u.exec(value)?.[1];
    if (!number) return;
    const digits = number.startsWith("00") ? `+${number.slice(2)}` : number;
    if (!/^(?:\+[1-9]\d{6,14}|\d{7,11})$/u.test(digits)) return;
    if (
      /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])$/u.test(
        digits,
      )
    )
      return;
    if (/^1[5-9]\d{8}$/u.test(digits)) return;
    return `tel:${digits}`;
  }
  if (type !== "url" || !/^https?:\/\//iu.test(value)) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return url.href;
  } catch {
    // The parser can identify text that does not form a valid URI.
  }
}

type GreetingState = {
  hasHistory: boolean;
  historyReady: boolean;
  blocked: boolean;
  pending: boolean;
};

export const waveGreeting = "👋";

export function canShowGreeting({
  hasHistory,
  historyReady,
  blocked,
  pending,
}: GreetingState) {
  return historyReady && !hasHistory && !blocked && !pending;
}

export function sendEmptyGreeting<T>(
  state: GreetingState,
  send: (text: string) => T,
) {
  if (canShowGreeting(state)) return send(waveGreeting);
}
