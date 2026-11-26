export type TabFrame = {
  from?: string;
  to?: string;
  sign: 1 | -1;
};

export type TabTravel =
  | { kind: "unchanged" }
  | { kind: "settle"; frame: TabFrame }
  | { kind: "slide"; frame: TabFrame; start: number };

export function resolveTabPressTarget(
  state: {
    index: number;
    routeNames: readonly string[];
    routes: readonly { name: string; key: string }[];
  },
  name: string,
  href: string,
) {
  // Expo Router creates a registered route's instance on its first visit.
  if (!state.routeNames.includes(name)) return undefined;
  return {
    eventTarget: state.routes.find((route) => route.name === name)?.key ?? href,
    selected: state.routes[state.index]?.name === name,
  };
}

export function nextTabTravel(
  previous: TabFrame,
  progress: number,
  active: string | undefined,
  physicalOrder: readonly string[],
  reduceMotion: boolean,
): TabTravel {
  "worklet";
  const last = physicalOrder.indexOf(previous.to ?? "");
  const selected = physicalOrder.indexOf(active ?? "");
  if (reduceMotion || last < 0 || selected < 0)
    return { kind: "settle", frame: { to: active, sign: 1 } };
  if (previous.to === active) return { kind: "unchanged" };
  const sign = selected > last ? 1 : -1;
  const reversing = active === previous.from && sign === -previous.sign;
  return {
    kind: "slide",
    frame: { from: previous.to, to: active, sign },
    start: reversing ? 1 - progress : 0,
  };
}
