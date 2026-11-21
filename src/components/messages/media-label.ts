import type { AttachmentKind } from "@/core/media/protocol";

export const mediaLabels = {
  voice: "messages:voiceMessage",
  image: "messages:mediaPhoto",
  video: "messages:mediaVideo",
  "round-video": "messages:mediaVideoNote",
  file: "messages:mediaFile",
  location: "messages:mediaLocation",
} as const satisfies Record<AttachmentKind | "location", string>;

export type MediaLabel = (kind: keyof typeof mediaLabels) => string;
