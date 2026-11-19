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
import { directionFor, resolveLanguage } from "@/i18n";
import { dark, light, space, type, useTheme } from "@/theme";

const appearance: ChatAppearanceName = "soft";

const icons: ChatIcons = {
  arrowLeft: (props) => <Icon name="back" {...props} />,
  chevronLeft: (props) => <Icon name="previous" {...props} />,
  pencil: (props) => <Icon name="add" {...props} />,
  send: (props) => <Icon name="send" {...props} />,
  reply: (props) => <Icon name="reply" {...props} />,
  forward: (props) => <Icon name="forward" {...props} />,
  backspace: (props) => <Icon name="erase" {...props} />,
};

export const conversationMaterials = {
  light: {
    canvas: ["#F0EEFC", "#E7EDF8", "#E2F0EF"],
    contours: "#546491",
    panel: "#F9F9FF",
    rim: "#CED5EA",
    incoming: "#FDFDFF",
    outgoing: ["#4F459D", "#385AA8"],
  },
  dark: {
    canvas: ["#19162D", "#101929", "#10272B"],
    contours: "#B3BCD8",
    panel: "#24293E",
    rim: "#454D67",
    incoming: "#232C40",
    outgoing: ["#5946A4", "#3A519C"],
  },
} satisfies Record<
  "light" | "dark",
  {
    canvas: [string, string, string];
    contours: string;
    panel: string;
    rim: string;
    incoming: string;
    outgoing: [string, string];
  }
>;

function chatTheme(
  colors: typeof light,
  material?: (typeof conversationMaterials)["light"],
): PartialChatTheme {
  return {
    colors: {
      background: material ? "transparent" : colors.background,
      accent: material?.outgoing[0] ?? colors.outgoing,
      onAccent: colors.outgoingInk,
      incomingBubble: material?.incoming ?? colors.surface,
      incomingText: colors.text,
      incomingMeta: colors.muted,
      outgoingBubble: material?.outgoing[0] ?? colors.outgoing,
      outgoingText: colors.outgoingInk,
      outgoingMeta: "#E5EBFF",
      inputBarBackground: material ? "transparent" : colors.background,
      inputBackground: material?.panel ?? colors.surface,
      inputFieldBorder: material?.rim ?? colors.line,
      inputText: colors.text,
      placeholder: colors.muted,
      composerIcon: colors.accent,
      inputCursor: colors.accent,
      selectionBackground: colors.accentSoft,
      surface: colors.surface,
      separator: colors.line,
      error: colors.danger,
      incomingLink: colors.accent,
      outgoingLink: "#FFFFFF",
      incomingReplyLine: colors.accent,
      incomingReplyName: colors.accent,
      outgoingReplyLine: "#E5EBFF",
      outgoingReplyName: "#FFFFFF",
      dayPillBackground: colors.accentSoft,
      dayPillText: colors.text,
      unreadSeparatorBackground: colors.accentSoft,
      unreadSeparatorText: colors.accent,
      unreadSeparatorArrow: colors.accent,
      scrollToBottomBackground: colors.surface,
      scrollToBottomIcon: colors.accent,
      scrollToBottomBadge: colors.outgoing,
      scrollToBottomBadgeText: colors.outgoingInk,
    },
    chatList: {
      background: colors.background,
      headerBackground: colors.surface,
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
      pressed: colors.accentSoft,
      selectedRow: colors.accentSoft,
      checkbox: colors.outgoing,
      swipeArchive: colors.outgoing,
      swipeUnarchive: colors.muted,
      fab: colors.outgoing,
      fabIcon: colors.outgoingInk,
    },
    contextMenu: {
      background: colors.surface,
      text: colors.text,
      icon: colors.muted,
      pressed: colors.accentSoft,
      destructive: colors.danger,
      reactionSelected: colors.accentSoft,
    },
    emojiKeyboard: {
      background: colors.surface,
      tabIndicator: colors.accentSoft,
      icon: colors.muted,
      iconSelected: colors.accent,
      sectionTitle: colors.text,
      searchBackground: colors.background,
      searchText: colors.text,
      searchIcon: colors.muted,
      popupBackground: colors.surface,
    },
    bubble: {
      outgoingGradient: material?.outgoing ?? null,
      outgoingGradientMode: "bubble",
      hasTail: false,
    },
    typography: {
      message: material ? { fontSize: 16, lineHeight: 21 } : type.body,
      composer: type.body,
      ...(material ? { time: { fontSize: 11 }, day: { fontSize: 12 } } : {}),
    },
    ...(material
      ? {
          radii: {
            bubble: 18,
            bubbleGrouped: 7,
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
const detailTheme = chatTheme(light, conversationMaterials.light);
const detailDarkTheme = chatTheme(dark, conversationMaterials.dark);

export function useChatAppearance(detail = false) {
  const app = useTheme();
  const { t, i18n } = useTranslation("chatKit");
  const locale = resolveLanguage(i18n.resolvedLanguage);
  const rtl = directionFor(locale) === "rtl";
  const labels = useMemo(
    () => t("labels", { returnObjects: true }) satisfies Partial<ChatLabels>,
    [t],
  );
  return {
    appearance,
    theme: detail ? detailTheme : theme,
    darkTheme: detail ? detailDarkTheme : darkTheme,
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
