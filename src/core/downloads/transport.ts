import type { BlossomDownload, DownloadSource, MarmotDownload } from "./types";

export type TransferProgress = {
  state: string;
  received: number;
  total?: number;
};
export type DownloadControl = "pause" | "cancel" | "remove";
export type DownloadFile = { path: string; type: string; name: string };

export type DownloadTransport<S extends DownloadSource = DownloadSource> = {
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
): DownloadTransport {
  function apply<T>(
    source: DownloadSource,
    invoke: <S extends DownloadSource>(
      transport: DownloadTransport<S>,
      target: S,
    ) => T,
  ): T {
    if (source.kind === "marmot") return invoke(marmot, source);
    return invoke(blossom, source);
  }
  return {
    async recover(sources) {
      await blossom.recover?.(
        sources.filter((source) => source.kind === "http"),
      );
    },
    transfer: (source, progress, signal) =>
      apply(source, (transport, target) =>
        transport.transfer(target, progress, signal),
      ),
    status: (source) =>
      apply(source, (transport, target) => transport.status(target)),
    retainedSize: async (source) =>
      apply(
        source,
        (transport, target) => transport.retainedSize?.(target) ?? null,
      ),
    control: (source, action) =>
      apply(source, (transport, target) => transport.control(target, action)),
    open: async (source, consume) =>
      apply(source, (transport, target) => transport.open?.(target, consume)),
  };
}
