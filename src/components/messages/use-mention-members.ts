import { useCallback, useEffect, useMemo, useState } from "react";
import { marmot, type MarmotGroupDetails } from "@/core/marmot/native";
import { contactByKey } from "@/db/queries";
import { useLocal } from "@/services/local-context";
import { loadGroupDetails } from "./group-details-cache";
import { useMarmotWindow } from "./marmot-window";

export function useMentionMembers(group: string, enabled: boolean) {
  const { db, marmotSession } = useLocal();
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
  const members = useMemo(
    () =>
      roster?.map((member) => ({
        ...member,
        label:
          contactByKey(db, member.id).get()?.name ?? member.name ?? member.npub,
      })),
    [db, roster],
  );
  return {
    members,
    failed: Boolean(error || (current && !roster)),
    retry: () => {
      if (error) retry();
      else setAttempt((value) => value + 1);
    },
  };
}
