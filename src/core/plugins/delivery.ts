import { type EventSubscription, requireOptionalNativeModule } from "expo";
import { z } from "zod";

const state = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notInstalled") }),
  z.object({
    kind: z.literal("installing"),
    sessionId: z.number().int().nonnegative(),
    received: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("confirmation"),
    sessionId: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("installed") }),
  z.object({ kind: z.literal("failed"), errorCode: z.number().int() }),
  z.object({ kind: z.literal("pendingRemoval") }),
]);

export type DeliveryState = z.infer<typeof state>;

const native = requireOptionalNativeModule<{
  status(): Promise<unknown>;
  install(): Promise<unknown>;
  cancel(sessionId: number): Promise<void>;
  confirm(sessionId: number): Promise<boolean>;
  uninstall(): Promise<void>;
  load(): Promise<number>;
  execute(scope: string, request: string): Promise<string>;
  addListener(
    event: "onDeliveryChanged",
    listener: () => void,
  ): EventSubscription;
}>("BoopPluginDelivery");

export const torrentDelivery = native && {
  status: async () => state.parse(await native.status()),
  install: async () => state.parse(await native.install()),
  cancel: (sessionId: number) => native.cancel(sessionId),
  confirm: (sessionId: number) => native.confirm(sessionId),
  uninstall: () => native.uninstall(),
  load: () => native.load(),
  execute: (scope: string, request: string) => native.execute(scope, request),
  subscribe: (listener: () => void) => {
    const subscription = native.addListener("onDeliveryChanged", listener);
    return () => subscription.remove();
  },
};

export type TorrentDelivery = NonNullable<typeof torrentDelivery>;
