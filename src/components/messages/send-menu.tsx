import { Host, Popover, RNHostView } from "@expo/ui/swift-ui";
import {
  Send,
  type IMessage,
  type SendProps,
} from "@kesha-antonov/react-native-chat";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Action, Icon } from "@/components/ui/kit";
import { useTheme } from "@/theme";

export type SendMenuProps<T extends IMessage> = SendProps<T> & {
  onOpenLater: () => void;
};

export function SendMenu<T extends IMessage>({
  onOpenLater,
  ...props
}: SendMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const { theme } = useTheme();
  const { t } = useTranslation("messages");

  return (
    <Host colorScheme={theme} matchContents>
      <Popover
        isPresented={open}
        onIsPresentedChange={setOpen}
        attachmentAnchor="top"
        arrowEdge="bottom"
      >
        <Popover.Trigger>
          <RNHostView matchContents>
            <Send
              {...props}
              sendButtonProps={{
                ...props.sendButtonProps,
                onLongPress: () => setOpen(true),
                accessibilityActions: [
                  { name: "longpress", label: t("sendOptions") },
                ],
                onAccessibilityAction: ({ nativeEvent }) => {
                  if (nativeEvent.actionName === "longpress") setOpen(true);
                },
              }}
            />
          </RNHostView>
        </Popover.Trigger>
        <Popover.Content>
          <RNHostView matchContents>
            <Action
              variant="ghost"
              onPress={() => {
                setOpen(false);
                onOpenLater();
              }}
            >
              <Icon name="timedLock" size={20} />
              {t("openLater")}
            </Action>
          </RNHostView>
        </Popover.Content>
      </Popover>
    </Host>
  );
}
