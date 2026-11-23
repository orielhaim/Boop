import type { DownloadSource } from "./types";

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
    attach: boolean,
  ): Promise<string>;
  status(source: S): Promise<string | undefined>;
  control(source: S, action: DownloadControl): Promise<void>;
  open?(
    source: S,
    consume: (file: DownloadFile) => Promise<void>,
  ): Promise<void>;
};

export function downloadTransports(
  marmot: DownloadTransport<Extract<DownloadSource, { kind: "marmot" }>>,
  http: DownloadTransport<Extract<DownloadSource, { kind: "http" }>>,
): DownloadTransport {
  return {
    recover: (sources) =>
      http.recover?.(sources.filter((s) => s.kind === "http")) ??
      Promise.resolve(),
    transfer: (source, progress, signal, attach) =>
      source.kind === "marmot"
        ? marmot.transfer(source, progress, signal, attach)
        : http.transfer(source, progress, signal, attach),
    status: (source) =>
      source.kind === "marmot" ? marmot.status(source) : http.status(source),
    control: (source, action) =>
      source.kind === "marmot"
        ? marmot.control(source, action)
        : http.control(source, action),
    open: async (source, consume) => {
      if (source.kind === "marmot") await marmot.open?.(source, consume);
      else await http.open?.(source, consume);
    },
  };
}
