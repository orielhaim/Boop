import {
  AttachmentMenu,
  type AttachmentMenuRenderProps,
  ChatContext,
  type IChatContext,
  useChatContext,
} from "@kesha-antonov/react-native-chat";
import { type ReactNode, useLayoutEffect } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { GlassSurface } from "@/components/glassyui/glass-surface";

type AttachmentTrayRequest = AttachmentMenuRenderProps & {
  chat: IChatContext;
};

export const createAttachmentTray = () =>
  createStore<AttachmentTrayRequest | null>(() => null);

type AttachmentTrayStore = ReturnType<typeof createAttachmentTray>;

export function AttachmentTrayTrigger({
  visible,
  tabs,
  onClose,
  onSend,
  tray,
  allowed,
}: AttachmentMenuRenderProps & {
  tray: AttachmentTrayStore;
  allowed: boolean;
}) {
  const chat = useChatContext();
  useLayoutEffect(() => {
    if (visible && !allowed) onClose();
    tray.setState(
      visible && allowed ? { visible, tabs, onClose, onSend, chat } : null,
      true,
    );
  }, [allowed, chat, onClose, onSend, tabs, tray, visible]);
  useLayoutEffect(() => () => tray.setState(null, true), [tray]);
  return null;
}

export function AttachmentTrayBoundary({
  children,
  tray,
}: {
  children: ReactNode;
  tray: AttachmentTrayStore;
}) {
  const open = useStore(tray, Boolean);
  return (
    <View
      style={styles.content}
      accessibilityElementsHidden={open}
      importantForAccessibility={open ? "no-hide-descendants" : "auto"}
    >
      {children}
    </View>
  );
}

export function AttachmentTray({ tray }: { tray: AttachmentTrayStore }) {
  const request = useStore(tray);
  if (!request) return null;
  const { chat, ...menu } = request;
  return (
    <ChatContext.Provider value={chat}>
      <View style={styles.layer}>
        <AttachmentMenu
          {...menu}
          inline
          isGalleryGridEnabled={false}
          background={
            <GlassSurface
              preset="overlay"
              elevation="none"
              style={styles.background}
            />
          }
        />
      </View>
    </ChatContext.Provider>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1 },
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
  },
  background: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 0,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
});
