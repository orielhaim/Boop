import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Action, Ink } from "@/components/ui/kit";
import {
  createTimeLockOpener,
  parseTimeLock,
  TimeLockError,
  type UnlockFailure,
} from "@/core/messaging/special-messages/timelock";
import { preference, setPreference } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";
import { canRetryUnlock, LockedMessageBubble } from "./timelock-message";

const unlock = createTimeLockOpener();

export function readTimeLock(content: string) {
  try {
    return parseTimeLock(JSON.parse(content));
  } catch {
    return null;
  }
}

export function MarmotLocked({
  message,
  content,
  active,
  rtl,
}: {
  message: string;
  content: string;
  active: boolean;
  rtl: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { db, lock } = useLocal();
  const { colors } = useTheme();
  const cacheKey = `marmot.opened.${message}`;
  const [text, setText] = useState(() => preference(db, cacheKey));
  const [error, setError] = useState<UnlockFailure | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const payload = readTimeLock(content);
    if (!payload || !active || text !== null) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      if (!payload || abort.signal.aborted) return;
      const now = Date.now();
      const due = Math.max(payload.requestedAt, payload.roundTime);
      if (now < due) {
        timer = setTimeout(schedule, Math.min(due - now + 100, 2_147_483_647));
        return;
      }
      if (lock.getState().locked || !lock.getState().active) return;
      void unlock(payload, abort.signal)
        .then((body) => {
          if (
            body === null ||
            abort.signal.aborted ||
            lock.getState().locked ||
            !lock.getState().active
          )
            return;
          setPreference(db, cacheKey, body);
          setText(body);
        })
        .catch((reason) => {
          if (!abort.signal.aborted)
            setError(
              reason instanceof TimeLockError ? reason.code : "decryption",
            );
        });
    }
    schedule();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [active, cacheKey, content, db, lock, retry, text]);

  if (active && text !== null) return <Ink>{text}</Ink>;
  const payload = readTimeLock(content);
  if (!payload) return <Ink>{t("messages:lockedInvalid")}</Ink>;
  return (
    <>
      <LockedMessageBubble
        lock={{ requestedAt: payload.requestedAt, error }}
        color={colors.text}
        rtl={rtl}
      />
      {canRetryUnlock(error) && (
        <Action
          size="sm"
          onPress={() => {
            setError(null);
            setRetry((value) => value + 1);
          }}
        >
          {t("common:retry")}
        </Action>
      )}
    </>
  );
}
