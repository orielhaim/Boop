import { firstPreviewUrl } from "../messaging/link-previews";
import type { MarmotMessage } from "./native";

type VisibleMessage = Pick<
  MarmotMessage,
  "id" | "sender" | "text" | "deleted" | "eventKind" | "attachments"
>;

// The active Chat Kit viewport is the authorization source for derived text
// and preview requests. The map is cleared when the screen loses eligibility.
export function createMarmotViewport(
  localKey: string,
  allowed: () => boolean,
  blocked: (key: string) => boolean,
) {
  let live: { group: string; rows: Map<string, VisibleMessage> } | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  function message(id: string) {
    const item = allowed() ? live?.rows.get(id) : undefined;
    if (item && !blocked(item.sender)) return item;
  }
  return {
    update(group: string, rows: VisibleMessage[]) {
      const next = {
        group,
        rows: new Map(
          rows
            .filter(
              (row) =>
                !row.deleted && (row.eventKind === 9 || row.eventKind === 1111),
            )
            .map((row) => [row.id, row]),
        ),
      };
      live = next;
      notify();
      return () => {
        if (live === next) {
          live = undefined;
          notify();
        }
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    authorizePreview(target: { peer: string; id: string; url: string }) {
      const row = message(target.id);
      return (
        live?.group === target.peer &&
        Boolean(
          row &&
          row.attachments.length === 0 &&
          firstPreviewUrl(row.text) === target.url,
        )
      );
    },
    incomingText(id: string) {
      const row = message(id);
      return row && row.sender !== localKey ? row.text : undefined;
    },
  };
}
