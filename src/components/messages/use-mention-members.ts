import { useCallback, useMemo } from "react";
import { marmot } from "@/core/marmot/native";
import { useContacts } from "@/db/contacts";
import { useMarmotWindow } from "./marmot-window";

export function useMentionMembers(group: string, enabled: boolean) {
  const contacts = useContacts();
  const watch = useCallback(() => marmot.openGroupState(group), [group]);
  const { snapshot, error, retry } = useMarmotWindow(watch, enabled);
  const roster = snapshot?.details.members;
  const members = useMemo(() => {
    const names = new Map(
      contacts.map(({ publicKey, name }) => [publicKey, name]),
    );
    return roster?.map((member) => ({
      ...member,
      label: names.get(member.id) || member.name || member.npub,
    }));
  }, [contacts, roster]);
  return { members, failed: Boolean(error), retry };
}
