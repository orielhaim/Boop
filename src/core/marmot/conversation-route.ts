type Route = {
  key: string;
  name: string;
  params?: object;
};

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
  if (routes[index]?.name === "audio-player") index--;
  for (; index >= 0; index--) {
    const route = routes[index];
    if (route.key === routeKey) return true;
    const scene = marmotChatScene(route);
    if (scene?.kind !== "overlay" || scene.group !== group) break;
  }
  return false;
}
