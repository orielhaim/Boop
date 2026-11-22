import { publicKeySchema } from "../identity/keys";
import { publicMediaUrl } from "../media/url";

export function nip05Address(input: string) {
  const match = /^([a-z0-9_.-]{1,64})@([a-z0-9.-]{1,189})$/i.exec(input.trim());
  if (!match || match[1] !== match[1].toLowerCase()) return null;
  const url = publicMediaUrl(`https://${match[2]}/.well-known/nostr.json`);
  if (!url) return null;
  url.searchParams.set("name", match[1]);
  return { name: match[1], url: url.href };
}

export function nip05Key(value: unknown, name: string) {
  if (typeof value !== "object" || value === null || !("names" in value))
    return null;
  const names = value.names;
  if (
    typeof names !== "object" ||
    names === null ||
    !Object.hasOwn(names, name)
  )
    return null;
  const parsed = publicKeySchema.safeParse(Reflect.get(names, name));
  return parsed.success ? parsed.data : null;
}
