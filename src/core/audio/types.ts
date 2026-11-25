import { z } from "zod";
import { sourceSchema } from "@/core/downloads/types";
import { mediaId } from "@/core/media/source";

const metadata = {
  title: z.string(),
  subtitle: z.string().optional(),
  duration: z.number().finite().nonnegative().optional(),
  voice: z.boolean(),
};
export const trackSchema = z.discriminatedUnion("kind", [
  z.object({
    ...metadata,
    kind: z.literal("attachment"),
    source: sourceSchema,
  }),
  z.object({
    ...metadata,
    kind: z.literal("device"),
    file: z.string().regex(/^[a-f0-9-]{36}(\.[a-z0-9]{1,12})?$/u),
    type: z.string(),
  }),
]);
export type Track = z.infer<typeof trackSchema>;
export const trackId = mediaId;

export function voiceOrigin(track: Track | undefined) {
  return track?.voice &&
    track.kind === "attachment" &&
    track.source.kind === "marmot"
    ? track.source.target
    : undefined;
}

export function showMiniPlayer(
  track: Track | undefined,
  conversation?: string,
) {
  const origin = voiceOrigin(track);
  return !!track && (!origin || origin[0] !== conversation);
}

export const speeds = [0.5, 1, 1.2, 1.5, 1.7, 2] as const;
export type Speed = (typeof speeds)[number];
const checkpoint = z.object({
  track: trackSchema,
  position: z.number().nonnegative(),
});
export const savedPlayback = z.object({
  current: checkpoint.optional(),
  music: checkpoint.optional(),
  voiceInterlude: z.boolean().optional(),
  upcoming: z.array(trackSchema).max(500),
  history: z.array(trackSchema).max(100),
  repeat: z.enum(["off", "one", "all"]),
  shuffle: z.boolean(),
});
export type SavedPlayback = z.infer<typeof savedPlayback>;
export const initialPlayback: SavedPlayback = {
  upcoming: [],
  history: [],
  repeat: "off",
  shuffle: false,
};

export function audioFile(name: string, type: string) {
  return (
    type.toLowerCase().startsWith("audio/") ||
    (/^(application\/octet-stream|application\/ogg|)$/iu.test(type) &&
      /\.(aac|aif|aiff|alac|flac|m4a|mp3|oga|ogg|opus|wav|wma)$/iu.test(name))
  );
}

export function opensExternally(
  track: Track,
  preference: boolean,
  mode?: "internal" | "external",
) {
  return !track.voice && (mode ? mode === "external" : preference);
}
