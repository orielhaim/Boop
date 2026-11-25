import { router, useNavigation } from "expo-router";
import { Directory, File } from "expo-file-system";
import { useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { useAudioActions } from "@/components/audio/actions";
import { exportMarmotAttachment } from "@/components/messages/marmot-attachments";
import { useDialog } from "@/components/ui/dialog";
import { downloadId, sourceId } from "@/core/downloads/types";
import type { AttachmentPresentation } from "@/core/marmot/attachment-presentation";
import {
  marmot,
  type MarmotMessage,
  type SharedMediaRow,
} from "@/core/marmot/native";
import { mediaCategory, mediaTarget } from "@/core/marmot/shared-media";
import {
  authorizedMarmotAttachment,
  waitForMediaAuthority,
} from "@/core/media/authorization";
import {
  localMediaUri,
  openLocalAttachment,
} from "@/core/media/open-local-attachment";
import { useLocal } from "@/services/local-context";
import { videoFile } from "@/core/video/types";
import { mediaDownload } from "./use-library";

export const maxMediaSelection = 32;

export function useLibraryActions({
  presentation,
  interactive,
  hasLocal,
  onView,
  onCloseViewer,
  onForward,
  onRemoved,
  onBatchComplete,
}: {
  presentation: AttachmentPresentation;
  interactive: boolean;
  hasLocal(row: SharedMediaRow): boolean;
  onView(row: SharedMediaRow): void;
  onCloseViewer(): void;
  onForward(row: SharedMediaRow, message: MarmotMessage): void;
  onRemoved(row: SharedMediaRow): void;
  onBatchComplete(): void;
}) {
  const { t } = useTranslation(["messages", "common", "audio"]);
  const {
    chatPreferences,
    downloads,
    identity,
    lock,
    marmotSession,
    privacy,
    video,
  } = useLocal();
  const navigation = useNavigation();
  const playback = useAudioActions();
  const dialog = useDialog();
  const [batchBusy, setBatchBusy] = useState(false);
  const batchInProgress = useRef(false);

  function fail() {
    if (navigation.isFocused() && !lock.getState().locked)
      void dialog.show({
        title: t("messages:sharedMedia.unavailable"),
        tone: "error",
      });
  }
  async function withAuthority(
    row: SharedMediaRow,
    consume: (message: MarmotMessage) => Promise<void> | void,
  ) {
    const revision = marmotSession.revision();
    const current = () =>
      navigation.isFocused() &&
      AppState.currentState === "active" &&
      !lock.getState().locked &&
      marmotSession.revision() === revision &&
      chatPreferences.enabled() &&
      !privacy.isBlocked(row.sender) &&
      !chatPreferences.hidden(row.group).includes(row.message) &&
      (row.expiresAt == null || row.expiresAt * 1000 > Date.now());
    if (!current()) throw new Error("MediaUnavailable");
    const window = await marmot.openConversation(row.group, {
      target: row.message,
    });
    const signal = new AbortController();
    const invalidate = () => {
      if (!current()) signal.abort();
    };
    const unfocus = navigation.addListener("blur", invalidate);
    const unlock = lock.subscribe(invalidate);
    const unaccount = marmotSession.subscribe(invalidate);
    const foreground = AppState.addEventListener("change", invalidate);
    try {
      invalidate();
      await waitForMediaAuthority(window, signal.signal);
      const message = authorizedMarmotAttachment(
        window.getState(),
        {
          target: mediaTarget(row),
          sender: row.sender,
        },
        privacy.isBlocked,
      );
      if (!current() || !message) throw new Error("MediaUnavailable");
      await consume(message);
    } finally {
      unfocus();
      unlock();
      unaccount();
      foreground.remove();
      await window.close();
    }
  }
  async function download(row: SharedMediaRow) {
    await withAuthority(row, () => {
      const source = mediaDownload(row, identity.publicKey);
      const id = sourceId(source);
      if (downloads.get(id)?.state === "paused") downloads.resume(id);
      else downloads.enqueue(source);
    });
  }
  async function remove(row: SharedMediaRow) {
    await withAuthority(row, async () => {
      presentation.invalidateLocal(mediaTarget(row));
      await downloads.removeRetainedMarmot(
        mediaDownload(row, identity.publicKey),
      );
    });
    onRemoved(row);
  }
  function confirmRemove(
    items: readonly SharedMediaRow[],
    surfaceDialog = dialog,
  ) {
    void surfaceDialog.show({
      title: t("messages:sharedMedia.removeCopy"),
      message: t("messages:sharedMedia.removeCopyHint"),
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("common:remove"),
          tone: "danger",
          onSelect: () => void batchRun(items, remove),
        },
      ],
    });
  }
  async function batchRun(
    items: readonly SharedMediaRow[],
    perform: (row: SharedMediaRow) => Promise<void>,
  ) {
    if (batchInProgress.current) return;
    batchInProgress.current = true;
    setBatchBusy(true);
    let failed = false;
    for (const row of items.slice(0, maxMediaSelection)) {
      if (!navigation.isFocused() || lock.getState().locked) break;
      try {
        await perform(row);
      } catch {
        failed = true;
      }
    }
    batchInProgress.current = false;
    setBatchBusy(false);
    onBatchComplete();
    if (failed) fail();
  }
  async function saveBatch(items: readonly SharedMediaRow[]) {
    if (Platform.OS !== "android") {
      return batchRun(items, (row) =>
        withAuthority(row, () =>
          exportMarmotAttachment(
            presentation,
            mediaTarget(row),
            row.item,
            "save",
          ),
        ),
      );
    }
    const directory = await Directory.pickDirectoryAsync();
    if (!directory) return;
    await batchRun(items, (row) =>
      withAuthority(row, () =>
        presentation.useLocalFile(mediaTarget(row), async (file) => {
          await new File(localMediaUri(file.path)).copy(directory);
        }),
      ),
    );
  }
  function playVideo(row: SharedMediaRow) {
    const source = presentation.authorize(mediaTarget(row));
    if (!interactive || !source || row.item.round) return;
    onCloseViewer();
    void video
      .open(
        {
          kind: "attachment",
          source,
          title: row.item.name,
          duration: row.item.duration,
          dimensions: row.item.dimensions,
          thumbhash: row.item.thumbhash,
        },
        { openInBoop: true },
      )
      .then((opened) => {
        if (!opened && presentation.authorize(mediaTarget(row))) fail();
      })
      .catch(fail);
  }
  function open(row: SharedMediaRow) {
    if (!interactive || !presentation.authorize(mediaTarget(row))) return;
    if (
      !row.item.round &&
      (row.category === "video" || videoFile(row.item.name, row.item.type))
    ) {
      if (hasLocal(row)) playVideo(row);
      else showMenu(row);
      return;
    }
    if (mediaCategory(row) === "visual") {
      onView(row);
      return;
    }
    if (!hasLocal(row)) {
      showMenu(row);
      return;
    }
    if (row.item.type.startsWith("audio/")) {
      void playback
        .open({
          kind: "attachment",
          source: mediaDownload(row, identity.publicKey),
          title: row.item.name,
          voice: row.item.voice,
          duration: row.item.duration,
        })
        .catch(fail);
      return;
    }
    if (row.item.round) {
      showInChat(row);
      return;
    }
    void withAuthority(row, () =>
      presentation.useLocalFile(mediaTarget(row), openLocalAttachment),
    ).catch(fail);
  }
  function showInChat(row: SharedMediaRow) {
    void withAuthority(row, () => {
      onCloseViewer();
      router.push({
        pathname: "/chat/[key]",
        params: { key: `marmot-${row.group}`, messageTarget: row.message },
      });
    }).catch(fail);
  }
  function showMenu(
    row: SharedMediaRow,
    surfaceDialog = dialog,
    includeView = false,
  ) {
    if (!interactive || !presentation.authorize(mediaTarget(row))) return;
    const local = hasLocal(row);
    const job = downloads.get(downloadId(mediaTarget(row)));
    const transfer = job && ["active", "queued", "waiting"].includes(job.state);
    const exportFile = (action: "save" | "share") =>
      void withAuthority(row, () =>
        exportMarmotAttachment(
          presentation,
          mediaTarget(row),
          row.item,
          action,
        ),
      ).catch(fail);
    void surfaceDialog.show({
      title: row.item.name,
      actions: [
        {
          label: t("messages:sharedMedia.showInChat"),
          onSelect: () => showInChat(row),
        },
        ...(includeView
          ? [
              {
                label: t("messages:sharedMedia.view"),
                onSelect: () => {
                  onBatchComplete();
                  open(row);
                },
              },
            ]
          : []),
        ...(local
          ? [
              ...(!row.item.voice
                ? [
                    {
                      label: t("messages:mediaShare"),
                      onSelect: () => exportFile("share"),
                    },
                  ]
                : []),
              {
                label: t("messages:mediaSave"),
                onSelect: () => exportFile("save"),
              },
              ...(mediaCategory(row) === "music"
                ? [
                    {
                      label: t("audio:addQueue"),
                      onSelect: () =>
                        void withAuthority(row, () =>
                          playback.queue({
                            kind: "attachment",
                            source: mediaDownload(row, identity.publicKey),
                            title: row.item.name,
                            voice: false,
                            duration: row.item.duration,
                          }),
                        ).catch(fail),
                    },
                  ]
                : []),
              {
                label: t("messages:sharedMedia.forwardFile"),
                onSelect: () => {
                  void withAuthority(row, (message) => {
                    onCloseViewer();
                    onForward(row, message);
                  }).catch(fail);
                },
              },
              {
                label: t("messages:sharedMedia.removeCopy"),
                onSelect: () => confirmRemove([row], surfaceDialog),
              },
            ]
          : !transfer
            ? [
                {
                  label:
                    job?.state === "paused"
                      ? t("messages:sharedMedia.resume")
                      : t("messages:sharedMedia.download"),
                  onSelect: () => void download(row).catch(fail),
                },
              ]
            : []),
        { label: t("common:cancel"), tone: "cancel" },
      ],
    });
  }
  return {
    batchBusy,
    batchRun,
    confirmRemove,
    download,
    open,
    playVideo,
    saveBatch,
    showMenu,
    fail,
  };
}
