export type PluginDescriptor = {
  id: string;
  version: string;
  contractVersion: 1;
  platforms: readonly ("android" | "ios")[];
  deliveryModule?: string;
  settingsRoute?: `/settings/${string}`;
  downloadProvider?: { id: string; versions: readonly number[] };
  capabilities: readonly ("messageEmbed" | "downloadTransport")[];
};

export type Embed<Renderer extends string = string, Payload = unknown> = {
  id: string;
  renderer: Renderer;
  payload: Payload;
};

export type ContentProvider<Contribution extends Embed> = {
  prefix: string;
  match(content: string): readonly Contribution[];
};

export type Plugin<Contribution extends Embed> = {
  descriptor: PluginDescriptor;
  content?: ContentProvider<Contribution>;
  activate?(signal: AbortSignal): Promise<() => void | Promise<void>>;
};

export type PluginMessage = {
  text: string;
  eligible: boolean;
};

const maxMessageLength = 16_384;
const maxEmbeds = 6;

export function createPluginHost<Contribution extends Embed>(
  plugins: readonly Plugin<Contribution>[],
) {
  const registered = new Map(
    plugins.map((plugin) => [plugin.descriptor.id, plugin]),
  );
  if (registered.size !== plugins.length)
    throw new Error("Duplicate plugin ID");
  const active = new Map<string, AbortController>();
  const pending = new Map<string, Promise<void>>();
  let disposed = false;

  function deactivate(id: string) {
    active.get(id)?.abort();
    return pending.get(id) ?? Promise.resolve();
  }

  return {
    descriptors: plugins.map(({ descriptor }) => descriptor),
    match(message: PluginMessage) {
      if (
        disposed ||
        !message.eligible ||
        message.text.length > maxMessageLength
      )
        return [];
      const found = new Map<string, Contribution>();
      const lower = message.text.toLowerCase();
      for (const { descriptor, content } of registered.values()) {
        if (!content || !lower.includes(content.prefix)) continue;
        for (const embed of content.match(message.text)) {
          const key = `${descriptor.id}:${embed.id}`;
          if (!found.has(key)) found.set(key, { ...embed, id: key });
          if (found.size === maxEmbeds) return [...found.values()];
        }
      }
      return [...found.values()];
    },
    async activate(id: string) {
      const plugin = registered.get(id);
      if (disposed || !plugin?.activate) return;
      if (active.has(id)) await deactivate(id);
      if (disposed || active.has(id)) return;
      const controller = new AbortController();
      active.set(id, controller);
      let initialize: () => void = () => undefined;
      const initialized = new Promise<void>((resolve) => {
        initialize = resolve;
      });
      const retire = Promise.withResolvers<void>();
      const onAbort = () => retire.resolve();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const lifetime = Promise.resolve().then(async () => {
        let close: (() => void | Promise<void>) | undefined;
        try {
          if (plugin.activate && !controller.signal.aborted)
            close = await plugin.activate(controller.signal);
          initialize();
          if (close) await retire.promise;
        } finally {
          controller.signal.removeEventListener("abort", onAbort);
          try {
            await close?.();
          } finally {
            active.delete(id);
            pending.delete(id);
          }
        }
      });
      pending.set(id, lifetime);
      await Promise.race([initialized, lifetime]);
    },
    deactivate,
    async dispose() {
      disposed = true;
      const closing = await Promise.allSettled(
        [...active.keys()].map(deactivate),
      );
      for (const result of closing)
        if (result.status === "rejected") throw result.reason;
    },
  };
}
