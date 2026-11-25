type Route = {
  key: string;
  name: string;
  params?: object;
};

export function profileMorphParam(params: object | undefined) {
  "worklet";
  return params &&
    "profileMorph" in params &&
    typeof params.profileMorph === "string"
    ? params.profileMorph
    : undefined;
}

export function profileElementId(profile: string, part: "avatar" | "name") {
  "worklet";
  // The bounds accessor reserves ":" for groups, which allow one active member.
  return `profile-morph-${profile.replace(":", "-")}-${part}`;
}

export function marmotChatScene({
  name,
  params,
}: Pick<Route, "name" | "params">) {
  if (
    name !== "chat/[key]" ||
    !params ||
    !("key" in params) ||
    typeof params.key !== "string"
  )
    return;
  const group = /^marmot-([a-f0-9]{2,512})$/u.exec(params.key)?.[1];
  if (!group) return;
  const view = "view" in params ? params.view : undefined;
  return {
    group,
    kind:
      view === "details" || view === "edit" || view === "call"
        ? "overlay"
        : "conversation",
  } as const;
}

export function conversationWindowActive(
  { routes, index }: { routes: readonly Route[]; index: number },
  routeKey: string,
  group: string,
) {
  if (
    routes[index]?.name === "audio-player" ||
    routes[index]?.name === "video-player"
  )
    index--;
  for (; index >= 0; index--) {
    const route = routes[index];
    if (route.key === routeKey) return true;
    if (
      route.name === "person/[key]" &&
      routes[index - 1]?.key === routeKey &&
      route.params &&
      "key" in route.params &&
      typeof route.params.key === "string" &&
      profileMorphParam(route.params) === `person:${route.params.key}`
    )
      return true;
    const scene = marmotChatScene(route);
    if (scene?.kind !== "overlay" || scene.group !== group) break;
  }
  return false;
}
