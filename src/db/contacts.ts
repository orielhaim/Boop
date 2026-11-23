import { asc } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { useMemo } from "react";
import { toNpub } from "@/core/identity/keys";
import { useLocal } from "@/services/local-context";
import { contactByKey } from "./queries";
import { contacts } from "./schema";

export function useContacts() {
  const { db } = useLocal();
  const query = useMemo(
    () => db.select().from(contacts).orderBy(asc(contacts.name)),
    [db],
  );
  const stored = useMemo(() => query.all(), [query]);
  const live = useLiveQuery(query, [query]);
  return live.updatedAt ? live.data : stored;
}

export function useContact(publicKey: string) {
  const { db } = useLocal();
  return useLiveQuery(contactByKey(db, publicKey), [db, publicKey]).data[0];
}

export function nameOrAddress(name: string | undefined | null, key: string) {
  return name?.trim() || `${toNpub(key).slice(0, 15)}…`;
}
