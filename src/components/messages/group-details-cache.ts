import type { createMarmotSession } from "@/core/marmot/account-session";
import { marmot, type MarmotGroupDetails } from "@/core/marmot/native";

type Session = ReturnType<typeof createMarmotSession>;
type GroupPreview = {
  title?: string;
  details?: MarmotGroupDetails;
  photo?: { hash: string; uri: string };
};
const caches = new WeakMap<
  Session,
  {
    revision: number;
    groups: Map<string, GroupPreview>;
    requests: Map<string, Promise<MarmotGroupDetails>>;
  }
>();

function cache(session: Session) {
  const revision = session.revision();
  const current = caches.get(session);
  if (current?.revision === revision) return current;
  const next = {
    revision,
    groups: new Map<string, GroupPreview>(),
    requests: new Map<string, Promise<MarmotGroupDetails>>(),
  };
  caches.set(session, next);
  return next;
}

function remember(
  groups: Map<string, GroupPreview>,
  id: string,
  preview: GroupPreview,
) {
  groups.delete(id);
  groups.set(id, preview);
  if (groups.size > 24) {
    const oldest = groups.keys().next().value;
    if (oldest !== undefined) groups.delete(oldest);
  }
}

export function groupPreview(session: Session, id: string) {
  return cache(session).groups.get(id);
}

export function rememberGroupProfile(
  session: Session,
  id: string,
  title: string,
  photo?: GroupPreview["photo"],
) {
  const { groups } = cache(session);
  remember(groups, id, { ...groups.get(id), title, photo });
}

export async function loadGroupDetails(session: Session, id: string) {
  await session.ready();
  const { groups, requests } = cache(session);
  const existing = requests.get(id);
  if (existing) return existing;
  const request = marmot
    .groupDetails(id)
    .then((details) => {
      remember(groups, id, { ...groups.get(id), details });
      return details;
    })
    .finally(() => requests.delete(id));
  requests.set(id, request);
  return request;
}
