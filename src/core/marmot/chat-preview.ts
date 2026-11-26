import type { IconName } from "@/components/ui/kit";
import { z } from "zod";
import { messageContent } from "./message-content";

export const chatPreview = z.object({
  id: z.string(),
  sender: z.string(),
  senderName: z.string().nullish(),
  kind: z.number().int().nonnegative(),
  text: z.string().nullish(),
  expiresAt: z.number().nonnegative().nullish(),
  content: messageContent.nullish(),
  attachmentKind: z
    .enum(["photo", "video", "audio", "file", "mixed"])
    .nullish(),
  attachmentCount: z.number().int().nonnegative().optional(),
  attachmentPresentation: z.enum(["voice", "round"]).nullish(),
  system: z.object({ type: z.string(), name: z.string().nullish() }).nullish(),
  sticker: z.boolean().optional(),
  deleted: z.boolean().optional(),
  delivery: z
    .enum(["not_applicable", "pending", "delivered", "failed"])
    .optional(),
});

const groupEvents = {
  member_added: ["people", "messages:marmot.eventMemberAdded"],
  member_removed: ["people", "messages:marmot.eventMemberRemoved"],
  member_left: ["leave", "messages:marmot.eventMemberLeft"],
  admin_added: ["verified", "messages:marmot.eventAdminAdded"],
  admin_removed: ["verified", "messages:marmot.eventAdminRemoved"],
  group_renamed: ["edit", "messages:marmot.eventGroupRenamed"],
  group_avatar_changed: ["media", "messages:marmot.eventGroupAvatar"],
  disappearing_timer_changed: ["time", "messages:marmot.eventRetention"],
  group_disbanded: ["trash", "messages:marmot.eventDisbanded"],
} as const satisfies Record<string, readonly [IconName, string]>;

export function groupActivity(type: string) {
  return Object.hasOwn(groupEvents, type)
    ? groupEvents[type as keyof typeof groupEvents]
    : (["settings", "messages:marmot.eventGroupChanged"] as const);
}

const attachments = {
  photo: ["media", "messages:chatPreview.photo"],
  video: ["camera", "messages:chatPreview.video"],
  audio: ["audio", "messages:chatPreview.audio"],
  file: ["file", "messages:chatPreview.file"],
  mixed: ["attach", "messages:chatPreview.attachments"],
} as const satisfies Record<string, readonly [IconName, string]>;

type Preview = z.output<typeof chatPreview>;
type ActivityLabel =
  | ReturnType<typeof groupActivity>[1]
  | (typeof attachments)[keyof typeof attachments][1]
  | "messages:marmot.removedMessage"
  | "messages:lockedMessage"
  | "messages:marmot.locationPreview"
  | "messages:chatPreview.poll"
  | "messages:chatPreview.sticker"
  | "messages:voiceMessage"
  | "messages:chatPreview.videoNote";
type Presentation =
  | { kind: "text"; text: string }
  | {
      kind: "activity";
      icon: IconName;
      label: ActivityLabel;
      detail?: string;
      count?: number;
      system?: boolean;
    };

export function presentChatPreview(preview: Preview): Presentation | undefined {
  if (preview.deleted)
    return {
      kind: "activity",
      icon: "trash",
      label: "messages:marmot.removedMessage",
      system: true,
    };
  if (preview.system) {
    const { type, name } = preview.system;
    const [icon, label] = groupActivity(type);
    return {
      kind: "activity",
      icon,
      label,
      system: true,
      detail: type === "group_renamed" ? name?.trim() || undefined : undefined,
    };
  }
  if (preview.kind === 24881)
    return {
      kind: "activity",
      icon: "timedLock",
      label: "messages:lockedMessage",
    };
  if (preview.kind === 24883)
    return {
      kind: "activity",
      icon: "location",
      label: "messages:marmot.locationPreview",
    };
  if (preview.kind === 1068)
    return {
      kind: "activity",
      icon: "poll",
      label: "messages:chatPreview.poll",
      detail: preview.text?.trim() || undefined,
    };
  if (preview.kind !== 9 && preview.kind !== 1111) return;
  if (preview.sticker)
    return {
      kind: "activity",
      icon: "sticker",
      label: "messages:chatPreview.sticker",
    };
  const attachment = preview.attachmentKind;
  const text = preview.text?.trim();
  if (!attachment) return text ? { kind: "text", text } : undefined;
  const [icon, label] =
    attachment === "audio" && preview.attachmentPresentation === "voice"
      ? (["microphone", "messages:voiceMessage"] as const)
      : attachment === "video" && preview.attachmentPresentation === "round"
        ? (["camera", "messages:chatPreview.videoNote"] as const)
        : attachments[attachment];
  return {
    kind: "activity",
    icon,
    label,
    detail: text,
    count: preview.attachmentCount,
  };
}
