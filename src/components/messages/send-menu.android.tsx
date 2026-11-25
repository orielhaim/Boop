import {
  Box,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPopup,
  Host,
  RNHostView,
  Text,
} from "@expo/ui/jetpack-compose";
import { Send, type IMessage } from "@kesha-antonov/react-native-chat";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/kit";
import { useTheme } from "@/theme";
import type { SendMenuProps } from "./send-menu";

const popupProperties = { clippingEnabled: false };
const itemShape = { index: 0, count: 1 };

export function SendMenu<T extends IMessage>({
  onOpenLater,
  ...props
}: SendMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const { colors, theme } = useTheme();
  const { t } = useTranslation("messages");

  return (
    <Host colorScheme={theme} seedColor={colors.accent} matchContents>
      <Box>
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
        <DropdownMenuPopup
          expanded={open}
          onDismissRequest={() => setOpen(false)}
          anchorPosition="above"
          properties={popupProperties}
        >
          <DropdownMenuGroup shapes={itemShape}>
            <DropdownMenuItem
              shape={itemShape}
              onClick={() => {
                setOpen(false);
                onOpenLater();
              }}
            >
              <DropdownMenuItem.LeadingIcon>
                <RNHostView matchContents>
                  <Icon name="timedLock" size={20} color={colors.accent} />
                </RNHostView>
              </DropdownMenuItem.LeadingIcon>
              <DropdownMenuItem.Text>
                <Text>{t("openLater")}</Text>
              </DropdownMenuItem.Text>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuPopup>
      </Box>
    </Host>
  );
}
