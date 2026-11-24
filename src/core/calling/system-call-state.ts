import { z } from "zod";
import type { CallView } from "./controller";
import type { VideoState } from "./video";

const systemCallEvent = z.object({
  kind: z.enum([
    "end",
    "open",
    "failure",
    "pip-enter",
    "pip-exit",
    "pip-close",
  ]),
  callId: z.string(),
});

export function systemRemoteVideo(
  call: CallView | null,
  video: VideoState | null,
  privateMode: boolean,
) {
  if (
    privateMode ||
    call?.phase !== "connected" ||
    call.reconnecting ||
    video?.remote.phase !== "receiving"
  )
    return null;
  return video.remote.url;
}

export function systemCallCommand(call: CallView | null, payload: unknown) {
  const event = systemCallEvent.safeParse(payload).data;
  return call &&
    call.phase !== "ended" &&
    call.phase !== "ending" &&
    event?.callId === call.id
    ? event
    : null;
}
