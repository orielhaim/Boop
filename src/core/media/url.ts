export function publicMediaUrl(input: string) {
  if (input.length > 2048 || /[\s\\]/u.test(input)) return null;
  try {
    const url = new URL(input);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(
        host,
      ) ||
      /\.(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/u.test(
        host,
      )
    )
      return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function blossomHash(url: URL) {
  return /\/([a-f0-9]{64})(?:\.[a-z0-9]{1,8})?$/u.exec(url.pathname)?.[1];
}
