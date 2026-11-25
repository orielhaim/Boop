import { useTranslation } from "react-i18next";
import { marmotErrorCode } from "@/core/marmot/errors";
import { namespaces } from "@/i18n";

export function useMarmotError() {
  const { t } = useTranslation(namespaces);
  return (error: unknown) => {
    const code = marmotErrorCode(error);
    if (code === "GroupCommitPending")
      return t("messages:marmot.pendingCommit");
    if (code === "NoUsableRelay" || code === "Publish")
      return t("messages:marmot.relayError");
    if (code === "IdentityMismatch" || code === "SecretNotFound")
      return t("messages:marmot.identityMismatch");
    if (code === "GroupRemoved" || code === "AccountSignedOut")
      return t("messages:marmot.noLongerMember");
    if (code === "GroupInviteNotPending")
      return t("messages:marmot.inviteGone");
    if (code === "MissingMemberInboxRoute")
      return t("messages:marmot.missingInboxRoute");
    if (code === "DirectoryLookupIncomplete")
      return t("messages:marmot.temporarilyUnavailable");
    if (code === "MediaNotConfigured")
      return t("messages:marmot.mediaUnavailableForChat");
    if (
      code === "MediaAttachmentRejected" ||
      code === "MediaUnfetchable" ||
      code === "MediaUnavailable"
    )
      return t("messages:marmot.mediaReferenceUnavailable");
    if (code.includes("KeyPackage")) return t("messages:marmot.missingPackage");
    return t("messages:marmot.operationError");
  };
}
