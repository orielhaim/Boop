import { asc } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { toNpub } from "@/core/identity/keys";
import { useLocal } from "@/services/local-context";
import { contactByKey } from "./queries";
import { contacts } from "./schema";

export function useContacts() {
  const { db } = useLocal();
  return useLiveQuery(db.select().from(contacts).orderBy(asc(contacts.name)), [
    db,
  ]).data;
}

export function useContact(publicKey: string) {
  const { db } = useLocal();
  return useLiveQuery(contactByKey(db, publicKey), [db, publicKey]).data[0];
}

export function nameOrAddress(name: string | undefined | null, key: string) {
  return name ?? `${toNpub(key).slice(0, 15)}…`;
}

export function byNameOrKey(query: string, key: string, name?: string | null) {
  const value = query.trim().toLowerCase();
  return (
    !value ||
    Boolean(name?.toLowerCase().includes(value)) ||
    key.includes(value) ||
    toNpub(key).includes(value)
  );
}
