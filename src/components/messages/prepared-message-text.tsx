import {
  isSafeLinkUrl,
  type IMessage,
  MessageText,
  useTheme,
} from "@kesha-antonov/react-native-chat";
import type { ComponentProps, ReactNode } from "react";
import { Linking, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  type Content,
  type ContentNode,
  formatTimestamp,
  mentionLabel,
} from "@/core/marmot/message-content";

export function PreparedMessageText<TMessage extends IMessage>({
  content,
  names,
  ...props
}: ComponentProps<typeof MessageText<TMessage>> & {
  content?: Content | null;
  names: ReadonlyMap<string, string>;
}) {
  const { position = "left", currentMessage, trailing } = props;
  const { colors, typography, spacing } = useTheme();
  if (!content?.blocks.length || content.truncated)
    return <MessageText {...props} />;

  const outgoing = position === "right";
  const color = outgoing ? colors.outgoingText : colors.incomingText;
  const linkColor = outgoing ? colors.outgoingLink : colors.incomingLink;

  function render(node: ContentNode, key: number): ReactNode {
    if (node.kind === "break") return <Text key={key}>─────</Text>;
    if (node.kind === "timestamp") return formatTimestamp(node);
    if (node.kind === "nostr") return mentionLabel(node.text, names);
    if (node.kind === "text") return node.text;
    if (node.kind === "code" || node.kind === "math")
      return (
        <Text key={key} style={styles.code}>
          {node.text}
        </Text>
      );

    if (!("children" in node)) return null;
    const children = node.children.map(render);
    switch (node.kind) {
      case "link": {
        const url = node.destination?.replace(/[\t\n\r]/g, "").trim();
        if (!isSafeLinkUrl(url)) return <Text key={key}>{children}</Text>;
        const kind = url.startsWith("mailto:")
          ? "email"
          : url.startsWith("tel:")
            ? "phone"
            : "url";
        return (
          <Text
            key={key}
            accessibilityRole="link"
            style={[styles.link, { color: linkColor }]}
            onPress={() => {
              if (props.onPress) props.onPress(currentMessage, url, kind);
              else void Linking.openURL(url).catch(() => undefined);
            }}
          >
            {children}
          </Text>
        );
      }
      case "heading":
        return (
          <Text
            key={key}
            accessibilityRole="header"
            style={[
              styles.bold,
              {
                fontSize: Math.max(
                  typography.message.fontSize,
                  22 - node.level,
                ),
              },
            ]}
          >
            {children}
          </Text>
        );
      case "listItem":
        return (
          <Text key={key}>
            {node.text} {join(children, "\n")}
          </Text>
        );
      case "tableRow":
        return <Text key={key}>{join(children, "  |  ")}</Text>;
      case "list":
      case "table":
      case "details":
        return <Text key={key}>{join(children, "\n")}</Text>;
      case "quote":
        return (
          <Text key={key} style={styles.italic}>
            │ {join(children, "\n│ ")}
          </Text>
        );
      case "bold":
      case "italic":
      case "strike":
        return (
          <Text key={key} style={styles[node.kind]}>
            {children}
          </Text>
        );
      case "paragraph":
      case "tableCell":
        return <Text key={key}>{children}</Text>;
    }
  }

  return (
    <View
      style={[
        {
          marginTop: spacing.bubblePaddingV,
          marginBottom: spacing.bubblePaddingBottom,
          marginHorizontal: spacing.bubblePaddingH,
        },
        props.containerStyle?.[position],
      ]}
    >
      <Text
        style={[
          typography.message,
          { color },
          props.textStyle?.[position],
          props.customTextStyle,
        ]}
      >
        {join(content.blocks.map(render), "\n")}
        {trailing}
      </Text>
    </View>
  );
}

function join(nodes: ReactNode[], separator: string): ReactNode[] {
  return nodes.flatMap((node, index) => (index ? [separator, node] : [node]));
}

const styles = StyleSheet.create({
  bold: { fontWeight: "bold" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  link: { textDecorationLine: "underline" },
  code: { fontFamily: "monospace" },
});
