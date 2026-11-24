import "dayjs/locale/he";
import type {
  ChatAppearanceName,
  ChatIcons,
  ChatLabels,
  PartialChatTheme,
} from "@kesha-antonov/react-native-chat";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/kit";
import { GlassBackIcon } from "@/components/ui/back-button";
import type { ChatPresentation } from "@/core/marmot/chat-preferences";
import { directionFor, resolveLanguage } from "@/i18n";
import { dark, light, space, type, useTheme } from "@/theme";
import { avatarGradients, themes } from "@/theme/tokens";

const appearance: ChatAppearanceName = "soft";
const avatar = {
  palette: avatarGradients.map(([start]) => start),
  paletteEnd: avatarGradients.map(([, end]) => end),
  textColor: light.onMedia,
};

const icons = {
  arrowLeft: ({ color }) => <GlassBackIcon color={color} />,
  chevronLeft: (props) => <Icon name="previous" {...props} />,
  chevronDown: (props) => <Icon name="expand" {...props} />,
  plus: (props) => <Icon name="add" {...props} />,
  pencil: (props) => <Icon name="edit" {...props} />,
  send: (props) => <Icon name="send" {...props} />,
  reply: (props) => <Icon name="reply" {...props} />,
  forward: (props) => <Icon name="forward" {...props} />,
  backspace: (props) => <Icon name="erase" {...props} />,
  mic: (props) => <Icon name="microphone" {...props} />,
  camera: (props) => <Icon name="camera" {...props} />,
  play: (props) => <Icon name="play" {...props} />,
  pause: (props) => <Icon name="pause" {...props} />,
  close: (props) => <Icon name="close" {...props} />,
  clock: (props) => <Icon name="time" {...props} />,
  check: (props) => <Icon name="check" {...props} />,
  checkAll: (props) => <Icon name="checkAll" {...props} />,
  pin: (props) => <Icon name="pin" {...props} />,
  pinOff: (props) => <Icon name="unpin" {...props} />,
  pushpin: (props) => <Icon name="pin" {...props} weight="fill" />,
  emoji: (props) => <Icon name="emoji" {...props} />,
  emojiAnimals: (props) => <Icon name="animals" {...props} />,
  emojiFood: (props) => <Icon name="food" {...props} />,
  emojiActivities: (props) => <Icon name="sports" {...props} />,
  emojiTravel: (props) => <Icon name="travel" {...props} />,
  emojiObjects: (props) => <Icon name="objects" {...props} />,
  emojiSymbols: (props) => <Icon name="star" {...props} />,
  emojiFlags: (props) => <Icon name="report" {...props} />,
  paperclip: (props) => <Icon name="attach" {...props} />,
  lock: (props) => <Icon name="timedLock" {...props} />,
  trash: (props) => <Icon name="trash" {...props} />,
  copy: (props) => <Icon name="copy" {...props} />,
  keyboard: (props) => <Icon name="keyboard" {...props} />,
  search: (props) => <Icon name="search" {...props} />,
  gallery: (props) => <Icon name="media" {...props} />,
  file: (props) => <Icon name="file" {...props} />,
  location: (props) => <Icon name="location" {...props} />,
  download: (props) => <Icon name="download" {...props} />,
  checkCircle: (props) => <Icon name="checkCircle" {...props} />,
  archive: (props) => <Icon name="archive" {...props} />,
  unarchive: (props) => <Icon name="unarchive" {...props} />,
  archiveFolder: (props) => <Icon name="archive" {...props} weight="fill" />,
  mute: (props) => <Icon name="bellOff" {...props} />,
  unmute: (props) => <Icon name="bell" {...props} />,
  verified: (props) => <Icon name="verified" {...props} weight="fill" />,
  reorder: (props) => <Icon name="reorder" {...props} />,
} satisfies Required<ChatIcons>;

export const conversationMaterials = {
  light: themes.light.conversation,
  dark: themes.dark.conversation,
};

export function messagePresentation({ textSize, rounding }: ChatPresentation) {
  return {
    text: { fontSize: textSize, lineHeight: Math.round((textSize * 21) / 16) },
    radii: { bubble: rounding, bubbleGrouped: Math.round((rounding * 7) / 18) },
  };
}

function chatTheme(
  colors: typeof light,
  detail?: {
    material: (typeof conversationMaterials)["light"];
    presentation: ChatPresentation;
  },
): PartialChatTheme {
  const material = detail?.material;
  const message = detail && messagePresentation(detail.presentation);
  return {
    avatar,
    colors: {
      background: material ? "transparent" : colors.background,
      accent: material?.outgoing[0] ?? colors.outgoing,
      onAccent: colors.outgoingInk,
      incomingBubble: material?.incoming ?? colors.grouped,
      incomingText: colors.text,
      incomingMeta: colors.muted,
      outgoingBubble: material?.outgoing[0] ?? colors.outgoing,
      outgoingText: colors.outgoingInk,
      outgoingMeta: "#E5EBFF",
      outgoingVoiceFill: colors.outgoingInk,
      outgoingVoiceTrack: "#FFFFFF80",
      inputBarBackground: material ? "transparent" : colors.background,
      inputBackground: material?.panel ?? colors.recessed,
      inputFieldBorder: material?.rim ?? colors.line,
      inputText: colors.text,
      placeholder: colors.muted,
      composerIcon: colors.accent,
      inputCursor: colors.accent,
      selectionBackground: colors.selected,
      surface: colors.raised,
      separator: colors.line,
      error: colors.danger,
      incomingLink: colors.accent,
      outgoingLink: "#FFFFFF",
      incomingReplyLine: colors.accent,
      incomingReplyName: colors.accent,
      outgoingReplyLine: "#E5EBFF",
      outgoingReplyName: "#FFFFFF",
      dayPillBackground: colors.selected,
      dayPillText: colors.text,
      unreadSeparatorBackground: colors.selected,
      unreadSeparatorText: colors.accent,
      unreadSeparatorArrow: colors.accent,
      scrollToBottomBackground: colors.raised,
      scrollToBottomIcon: colors.accent,
      scrollToBottomBadge: colors.outgoing,
      scrollToBottomBadgeText: colors.outgoingInk,
    },
    chatList: {
      background: colors.background,
      headerBackground: colors.background,
      headerText: colors.text,
      headerSubtitle: colors.muted,
      headerSubtitleActive: colors.accent,
      name: colors.text,
      message: colors.muted,
      senderPrefix: colors.muted,
      date: colors.muted,
      check: colors.accent,
      draft: colors.accent,
      badge: colors.outgoing,
      badgeMuted: colors.muted,
      badgeText: colors.outgoingInk,
      divider: colors.line,
      pressed: colors.pressed,
      selectedRow: colors.selected,
      checkbox: colors.outgoing,
      swipeArchive: colors.outgoing,
      swipeUnarchive: colors.muted,
      fab: colors.outgoing,
      fabIcon: colors.outgoingInk,
    },
    contextMenu: {
      background: colors.overlay,
      text: colors.text,
      icon: colors.muted,
      pressed: colors.selected,
      destructive: colors.danger,
      reactionSelected: colors.selected,
    },
    emojiKeyboard: {
      background: colors.raised,
      tabIndicator: colors.selected,
      icon: colors.muted,
      iconSelected: colors.accent,
      sectionTitle: colors.text,
      searchBackground: colors.recessed,
      searchText: colors.text,
      searchIcon: colors.muted,
      popupBackground: colors.raised,
    },
    bubble: {
      outgoingGradient: material?.outgoing ?? null,
      outgoingGradientMode: "bubble",
      hasTail: false,
      isTimeInline: false,
    },
    typography: {
      message: message?.text ?? type.message,
      composer: type.body,
      ...(material ? { time: { fontSize: 11 }, day: { fontSize: 12 } } : {}),
    },
    ...(message
      ? {
          radii: {
            ...message.radii,
            sendButton: 16,
            replyQuote: 9,
          },
          composer: { minHeight: 48 },
          sendButton: { size: 34 },
          spacing: {
            screenEdge: space.sm,
            betweenGroups: space.sm,
            withinGroup: 2,
            inputToolbarPaddingV: space.sm,
          },
        }
      : { spacing: { screenEdge: space.md, betweenGroups: space.md } }),
  };
}

const theme = chatTheme(light);
const darkTheme = chatTheme(dark);
export function useChatAppearance(presentation?: ChatPresentation) {
  const app = useTheme();
  const { t, i18n } = useTranslation("chatKit");
  const locale = resolveLanguage(i18n.resolvedLanguage);
  const rtl = directionFor(locale) === "rtl";
  const labels = useMemo(
    () => t("labels", { returnObjects: true }) satisfies Partial<ChatLabels>,
    [t],
  );
  const themes = useMemo(
    () =>
      presentation
        ? {
            theme: chatTheme(light, {
              material: conversationMaterials.light,
              presentation,
            }),
            darkTheme: chatTheme(dark, {
              material: conversationMaterials.dark,
              presentation,
            }),
          }
        : { theme, darkTheme },
    [presentation],
  );
  return {
    appearance,
    ...themes,
    colorScheme: app.theme,
    colors: app.colors,
    locale,
    rtl,
    icons,
    labels,
    reducedMotion: app.reduceMotion,
    reducedTransparency: app.reduceTransparency,
  };
}
