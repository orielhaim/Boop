import { AccessibilityInfo, Platform } from "react-native";

export type SystemAccessibility = {
  reduceMotion: boolean;
  reduceTransparency: boolean;
};

type Subscription = { remove: () => void };

// The system's accessibility settings, read once and shared by every glass component.
let snapshot: SystemAccessibility = {
  reduceMotion: false,
  reduceTransparency: false,
};

const listeners = new Set<() => void>();

let subscriptions: Subscription[] = [];

function update(next: Partial<SystemAccessibility>) {
  const merged = { ...snapshot, ...next };

  if (
    merged.reduceMotion === snapshot.reduceMotion &&
    merged.reduceTransparency === snapshot.reduceTransparency
  ) {
    return;
  }

  snapshot = merged;
  for (const listener of listeners) listener();
}

function warnReadFailure(cause: Error) {
  console.warn("Glassy UI could not read an accessibility setting", cause);
}

function startListening() {
  AccessibilityInfo.isReduceMotionEnabled()
    .then((reduceMotion) => update({ reduceMotion }))
    .catch(warnReadFailure);

  subscriptions.push(
    AccessibilityInfo.addEventListener("reduceMotionChanged", (reduceMotion) =>
      update({ reduceMotion }),
    ),
  );

  if (Platform.OS === "ios") {
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((reduceTransparency) => update({ reduceTransparency }))
      .catch(warnReadFailure);

    subscriptions.push(
      AccessibilityInfo.addEventListener(
        "reduceTransparencyChanged",
        (reduceTransparency) => update({ reduceTransparency }),
      ),
    );
  }

  // React Native for Web has no reduce-transparency event; the browser reports it directly.
  if (Platform.OS === "web" && window.matchMedia) {
    const query = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const handleChange = () => update({ reduceTransparency: query.matches });

    update({ reduceTransparency: query.matches });
    query.addEventListener("change", handleChange);
    subscriptions.push({
      remove: () => query.removeEventListener("change", handleChange),
    });
  }
}

export function subscribeToSystemAccessibility(listener: () => void) {
  listeners.add(listener);

  if (listeners.size === 1) startListening();

  return () => {
    listeners.delete(listener);

    if (listeners.size > 0) return;

    for (const subscription of subscriptions) subscription.remove();
    subscriptions = [];
  };
}

export function readSystemAccessibility() {
  return snapshot;
}
