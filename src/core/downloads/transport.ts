import type {
  BlossomDownload,
  DownloadSource,
  MarmotDownload,
  ProviderDownload,
} from "./types";

export type TransferProgress = {
  state: string;
  received: number;
  total?: number;
};
export type DownloadControl = "pause" | "cancel" | "remove";
export type DownloadFile = { path: string; type: string; name: string };

export type DownloadTransport<S extends DownloadSource = DownloadSource> = {
  available?(source: S): boolean;
  supportedVersions?: readonly number[];
  recover?(sources: S[]): Promise<void>;
  transfer(
    source: S,
    progress: (event: TransferProgress) => void,
    signal: AbortSignal,
  ): Promise<string>;
  status(source: S): Promise<string | undefined>;
  retainedSize?(source: S): Promise<number | null>;
  control(source: S, action: DownloadControl): Promise<void>;
  open?(
    source: S,
    consume: (file: DownloadFile) => Promise<void>,
  ): Promise<void>;
};

export function downloadTransports(
  marmot: DownloadTransport<MarmotDownload>,
  blossom: DownloadTransport<BlossomDownload>,
  providers: Record<string, DownloadTransport<ProviderDownload>> = {},
): DownloadTransport {
  function provider(source: ProviderDownload) {
    if (!Object.hasOwn(providers, source.provider)) return;
    const candidate = providers[source.provider];
    return candidate && candidate.supportedVersions?.includes(source.version)
      ? candidate
      : undefined;
  }
  function apply<T>(
    source: DownloadSource,
    invoke: <S extends DownloadSource>(
      transport: DownloadTransport<S>,
      target: S,
    ) => T,
  ): T | undefined {
    if (source.kind === "marmot") return invoke(marmot, source);
    if (source.kind === "http") return invoke(blossom, source);
    const transport = provider(source);
    if (!transport) return undefined;
    return invoke(transport, source);
  }
  return {
    available(source) {
      if (source.kind === "marmot") return marmot.available?.(source) ?? true;
      if (source.kind === "http") return blossom.available?.(source) ?? true;
      const transport = provider(source);
      return !!transport && (transport.available?.(source) ?? true);
    },
    async recover(sources) {
      const groups = new Map<DownloadTransport, DownloadSource[]>([
        [marmot, []],
        [blossom, []],
        ...Object.values(providers).map(
          (provider): [DownloadTransport, DownloadSource[]] => [provider, []],
        ),
      ]);
      for (const source of sources) {
        const transport =
          source.kind === "http"
            ? blossom
            : source.kind === "provider"
              ? provider(source)
              : marmot;
        if (!transport) continue;
        groups.set(transport, [...(groups.get(transport) ?? []), source]);
      }
      await Promise.all(
        [...groups].map(([transport, rows]) => transport.recover?.(rows)),
      );
    },
    transfer: (source, progress, signal) =>
      apply(source, (transport, target) =>
        transport.transfer(target, progress, signal),
      ) ?? Promise.resolve("unavailable"),
    status: (source) =>
      apply(source, (transport, target) => transport.status(target)) ??
      Promise.resolve("unavailable"),
    retainedSize: async (source) =>
      apply(
        source,
        (transport, target) => transport.retainedSize?.(target) ?? null,
      ) ?? Promise.resolve(null),
    control: (source, action) =>
      apply(source, (transport, target) => transport.control(target, action)) ??
      Promise.resolve(),
    open: async (source, consume) =>
      apply(source, (transport, target) => transport.open?.(target, consume)) ??
      Promise.resolve(),
  };
}
