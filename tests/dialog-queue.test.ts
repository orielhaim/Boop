import { describe, expect, test } from "bun:test";
import { createDialogQueue } from "@/components/ui/dialog-queue";

function owner() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    canPresent: () => true,
    unmount: () => controller.abort(),
  };
}

function activeId(queue: ReturnType<typeof createDialogQueue>) {
  const snapshot = queue.read();
  if (snapshot?.phase !== "active") throw new Error("No active dialog");
  return snapshot.dialog.id;
}

describe("application dialogs", () => {
  test("executes a selection once and shows the next request after exit", async () => {
    const queue = createDialogQueue(() => true);
    const scope = owner();
    let selected = 0;
    const first = queue.show(
      {
        title: "Continue?",
        actions: [
          {
            label: "Continue",
            onSelect: () => {
              selected++;
            },
          },
        ],
      },
      scope,
    );
    const second = queue.show({ title: "Next" }, scope);
    const id = activeId(queue);
    await Promise.all([queue.select(id, 0), queue.select(id, 0)]);
    expect(await first).toBe(0);
    expect(selected).toBe(1);
    expect(queue.read()?.phase).toBe("closing");
    queue.finishExit(id);
    expect(queue.read()?.dialog.request.title).toBe("Next");
    await queue.select(id, 0);
    expect(queue.read()?.dialog.request.title).toBe("Next");
    await queue.select(activeId(queue), 0);
    expect(await second).toBe(0);
  });

  test("consumes Back without dismissing a non-cancelable confirmation", async () => {
    const queue = createDialogQueue(() => true);
    const result = queue.show(
      {
        title: "Delete?",
        dismissible: false,
        actions: [{ label: "Cancel" }, { label: "Delete", disabled: true }],
      },
      owner(),
    );
    const id = activeId(queue);
    expect(queue.dismiss()).toBe(true);
    await queue.select(id, 1);
    expect(activeId(queue)).toBe(id);
    await queue.select(id, 0);
    expect(await result).toBe(0);
  });

  test("keeps async failures visible and permits an explicit retry", async () => {
    const queue = createDialogQueue(() => true);
    let attempts = 0;
    const result = queue.show(
      {
        title: "Clear cache?",
        actions: [
          {
            label: "Clear",
            async run() {
              attempts++;
              if (attempts === 1) throw new Error("Try again");
            },
          },
        ],
      },
      owner(),
    );
    const id = activeId(queue);
    const inFlight = queue.select(id, 0);
    expect(queue.read()?.dialog.pendingIndex).toBe(0);
    expect(queue.dismiss()).toBe(true);
    await Promise.all([inFlight, queue.select(id, 0)]);
    expect(attempts).toBe(1);
    expect(queue.read()?.dialog.failed).toBe(true);
    expect(queue.read()?.dialog.pendingIndex).toBeUndefined();
    await queue.select(id, 0);
    expect(await result).toBe(0);
    expect(attempts).toBe(2);
  });

  test("unmount and lock settle requests and ignore late action completion", async () => {
    let permitted = true;
    const queue = createDialogQueue(() => permitted);
    const scope = owner();
    const gate = Promise.withResolvers<void>();
    let aborted = false;
    const active = queue.show(
      {
        title: "Clear",
        actions: [
          {
            label: "Clear",
            run(signal) {
              signal.addEventListener("abort", () => {
                aborted = true;
              });
              return gate.promise;
            },
          },
        ],
      },
      scope,
    );
    const inFlight = queue.select(activeId(queue), 0);
    const waiting = queue.show({ title: "Pending from same screen" }, scope);
    const next = queue.show({ title: "Next screen" }, owner());
    scope.unmount();
    expect(aborted).toBe(true);
    expect(await active).toBeUndefined();
    expect(await waiting).toBeUndefined();
    expect(queue.read()?.dialog.request.title).toBe("Next screen");

    permitted = false;
    queue.revoke();
    expect(await next).toBeUndefined();
    gate.resolve();
    await inFlight;
    expect(await queue.show({ title: "Private" }, owner())).toBeUndefined();
    expect(queue.read()).toBeNull();
  });
});
