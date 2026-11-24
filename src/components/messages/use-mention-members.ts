import { useCallback, useEffect, useMemo, useState } from "react";
import { marmot, type MarmotGroupDetails } from "@/core/marmot/native";
import { useContacts } from "@/db/contacts";
import { useLocal } from "@/services/local-context";
import { loadGroupDetails } from "./group-details-cache";
import { useMarmotWindow } from "./marmot-window";

export function useMentionMembers(group: string, enabled: boolean) {
  const { marmotSession } = useLocal();
  const contacts = useContacts();
  const watch = useCallback(() => marmot.openGroupState(group), [group]);
  const { snapshot, error, retry } = useMarmotWindow(watch, enabled);
  const revision = snapshot && `${snapshot.generation}:${snapshot.sequence}`;
  const [result, setResult] = useState<{
    revision: string;
    attempt: number;
    members?: MarmotGroupDetails["members"];
  }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (revision === undefined) return;
    let active = true;
    void loadGroupDetails(marmotSession, group).then(
      (details) => {
        if (active) setResult({ revision, attempt, members: details.members });
      },
      () => {
        if (active) setResult({ revision, attempt });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, group, marmotSession, revision]);
  const current =
    result?.revision === revision && result?.attempt === attempt
      ? result
      : undefined;
  const roster = current?.members;
  const members = useMemo(() => {
    const names = new Map(
      contacts.map((contact) => [contact.publicKey, contact.name]),
    );
    return roster?.map((member) => ({
      ...member,
      label: names.get(member.id) || member.name || member.npub,
    }));
  }, [contacts, roster]);
  return {
    members,
    failed: Boolean(error || (current && !roster)),
    retry: () => {
      if (error) retry();
      else setAttempt((value) => value + 1);
    },
  };
}
