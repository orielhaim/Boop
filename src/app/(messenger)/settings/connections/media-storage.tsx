import { ScreenHeader } from "@/components/navigation/screen-header";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
import { Action, Screen, Search } from "@/components/ui/kit";
import { BlossomError, blossomServer } from "@/core/media/blossom";
import {
  maxMediaServers,
  mediaRoles,
  recommendedMediaServers,
  type MediaConfiguration,
  type MediaServer,
} from "@/core/media/servers";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function MediaServers() {
  const { t } = useTranslation(namespaces);
  const { mediaSdk, blossomLists } = useLocal();
  useSyncExternalStore(mediaSdk.subscribe, mediaSdk.revision);
  const config = mediaSdk.snapshot();
  const [url, setUrl] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<string[]>();
  const [publication, setPublication] = useState<string[]>();
  const checking = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => checking.current?.abort(), []);
  const preferredProfile = mediaSdk.configured("profile")[0]?.origin;
  const preferredAttachment = mediaSdk.configured("attachment")[0]?.origin;

  function save(next: MediaConfiguration) {
    try {
      mediaSdk.save(next);
      setNotice("");
      return true;
    } catch {
      setNotice(t("settings:mediaInvalid"));
      return false;
    }
  }

  function update(origin: string, patch: Partial<MediaServer>) {
    const latest = mediaSdk.snapshot();
    save({
      ...latest,
      servers: latest.servers.map((item) =>
        item.origin === origin ? { ...item, ...patch } : item,
      ),
    });
  }

  function move(origin: string, destination: number) {
    const latest = mediaSdk.snapshot();
    const servers = [...latest.servers];
    const index = servers.findIndex((server) => server.origin === origin);
    if (
      index < 0 ||
      destination < 0 ||
      destination >= servers.length ||
      index === destination
    )
      return;
    const [server] = servers.splice(index, 1);
    servers.splice(destination, 0, server);
    save({ ...latest, servers });
  }

  function add() {
    const origin = blossomServer(url);
    const latest = mediaSdk.snapshot();
    if (
      !origin ||
      latest.servers.some((item) => item.origin === origin) ||
      latest.servers.length >= maxMediaServers
    ) {
      setNotice(t("settings:mediaInvalid"));
      return;
    }
    if (
      save({
        ...latest,
        servers: [
          ...latest.servers,
          { origin, enabled: true, roles: ["profile"] },
        ],
      })
    ) {
      setExpanded(origin);
      setUrl("");
    }
  }

  async function check(origin: string) {
    checking.current?.abort();
    const job = new AbortController();
    checking.current = job;
    setNotice("");
    setBusy(true);
    try {
      await Promise.allSettled(
        mediaRoles.map((role) => mediaSdk.check(origin, role, job.signal)),
      );
    } finally {
      if (checking.current === job && !job.signal.aborted) setBusy(false);
    }
  }

  async function loadPublished() {
    setNotice("");
    setBusy(true);
    try {
      const origins = await blossomLists.discoverBlossomServers();
      setPublished(origins);
      if (!origins.length) setNotice(t("settings:mediaNoPublished"));
    } catch {
      setNotice(t("settings:mediaListFailed"));
    } finally {
      setBusy(false);
    }
  }

  function importPublished() {
    if (!published?.length) return;
    const latest = mediaSdk.snapshot();
    const added = published
      .filter(
        (origin) => !latest.servers.some((server) => server.origin === origin),
      )
      .slice(0, maxMediaServers - latest.servers.length);
    if (!added.length) {
      setNotice(t("settings:mediaNoNewServers"));
      return;
    }
    save({
      ...latest,
      servers: [
        ...latest.servers,
        ...added.map((origin): MediaServer => ({
          origin,
          enabled: false,
          roles: ["profile"],
        })),
      ],
    });
    setNotice(t("settings:mediaImported"));
  }

  function publish() {
    const origins = mediaSdk
      .snapshot()
      .servers.filter(
        (server) =>
          server.enabled &&
          server.roles.length &&
          publication?.includes(server.origin),
      )
      .map((server) => server.origin);
    if (!origins.length) {
      setNotice(t("settings:mediaNoCompatible"));
      return;
    }
    Alert.alert(
      t("settings:mediaPublish"),
      `${t("settings:mediaPublishConfirm")}

${origins.join("\n")}`,
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("settings:mediaPublish"),
          onPress: () => {
            setBusy(true);
            void blossomLists
              .publishBlossomServers(origins)
              .then((ok) => {
                setNotice(
                  t(
                    ok
                      ? "settings:mediaListPublished"
                      : "settings:mediaListFailed",
                  ),
                );
                if (ok) {
                  setPublished(origins);
                  setPublication(undefined);
                }
              })
              .catch((error: unknown) => {
                setNotice(
                  error instanceof BlossomError
                    ? t(`settings:mediaFailure_${error.code}`)
                    : t("settings:mediaListFailed"),
                );
              })
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  }

  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("settings:mediaStorage")} />}
    >
      <SettingsDescription>{t("settings:mediaHelp")}</SettingsDescription>
      {config.servers.map((server, index) => {
        const open = expanded === server.origin;
        const roleLabel = (role: (typeof mediaRoles)[number]) =>
          t(
            role === "profile"
              ? "settings:mediaRoleProfile"
              : "settings:mediaRolePrivate",
          );
        return (
          <ListGroup key={server.origin}>
            <ListRow
              title={server.origin}
              detail={
                (server.enabled
                  ? server.roles.map(roleLabel).join(" · ")
                  : t("common:off")) || t("settings:mediaNoCompatible")
              }
              value={
                server.origin === preferredProfile ||
                server.origin === preferredAttachment
                  ? t("settings:mediaPreferred")
                  : undefined
              }
              expanded={open}
              onPress={() => setExpanded(open ? undefined : server.origin)}
            />
            {open && (
              <>
                <PreferenceToggle
                  title={t("settings:mediaEnabled")}
                  value={server.enabled}
                  onChange={(enabled) => update(server.origin, { enabled })}
                />
                {mediaRoles.map((role) => {
                  const health = mediaSdk.health(server.origin, role);
                  const capabilities = health?.preflight
                    ? t(
                        health.preflight === "compatible"
                          ? "settings:mediaCompatible"
                          : "settings:mediaNoPreflight",
                      )
                    : undefined;
                  const failure = health?.lastFailure
                    ? t(`settings:mediaFailure_${health.lastFailure}`)
                    : undefined;
                  return (
                    <PreferenceToggle
                      key={role}
                      title={roleLabel(role)}
                      detail={
                        [capabilities, failure].filter(Boolean).join(" · ") ||
                        undefined
                      }
                      value={server.roles.includes(role)}
                      onChange={(enabled) =>
                        update(server.origin, {
                          roles: enabled
                            ? [...server.roles, role]
                            : server.roles.filter((item) => item !== role),
                        })
                      }
                    />
                  );
                })}
                <ListRow
                  title={t("settings:mediaCheck")}
                  disabled={busy}
                  onPress={() => void check(server.origin)}
                />
                <ListRow
                  title={t("settings:mediaMakePreferred")}
                  disabled={index === 0}
                  onPress={() => move(server.origin, 0)}
                />
                <ListRow
                  title={t("settings:mediaMoveUp")}
                  disabled={index === 0}
                  onPress={() => move(server.origin, index - 1)}
                />
                <ListRow
                  title={t("settings:mediaMoveDown")}
                  disabled={index === config.servers.length - 1}
                  onPress={() => move(server.origin, index + 1)}
                />
                <ListRow
                  title={t("settings:mediaRemove")}
                  icon="erase"
                  onPress={() => {
                    const latest = mediaSdk.snapshot();
                    save({
                      ...latest,
                      servers: latest.servers.filter(
                        (entry) => entry.origin !== server.origin,
                      ),
                    });
                  }}
                />
              </>
            )}
          </ListGroup>
        );
      })}
      <Search
        accessibilityLabel={t("settings:mediaAddress")}
        value={url}
        onChangeText={setUrl}
        keyboardType="url"
        autoCapitalize="none"
        placeholder="https://"
      />
      <Action onPress={add} disabled={!url.trim()}>
        {t("settings:mediaAdd")}
      </Action>
      <ListGroup>
        <PreferenceToggle
          title={t("settings:mediaMirror")}
          detail={t("settings:mediaMirrorDetail")}
          value={config.mirror}
          onChange={(mirror) => {
            save({ ...mediaSdk.snapshot(), mirror });
          }}
        />
        <ListRow
          title={t("settings:mediaFindPublished")}
          disabled={busy}
          onPress={() => void loadPublished()}
        />
        <ListRow
          title={t("settings:mediaPublish")}
          disabled={busy}
          onPress={() =>
            setPublication(publication ? undefined : (published ?? []))
          }
        />
        <ListRow
          title={t("settings:mediaRestore")}
          onPress={() =>
            Alert.alert(
              t("settings:mediaRestore"),
              t("settings:mediaRestoreDetail"),
              [
                { text: t("common:cancel"), style: "cancel" },
                {
                  text: t("settings:mediaRestore"),
                  onPress: () => {
                    save(recommendedMediaServers());
                  },
                },
              ],
            )
          }
        />
      </ListGroup>
      {publication && (
        <ListGroup title={t("settings:mediaPublicationSelection")}>
          {config.servers
            .filter((server) => server.enabled && server.roles.length)
            .map(({ origin }) => (
              <PreferenceToggle
                key={origin}
                title={origin}
                value={publication.includes(origin)}
                onChange={(checked) => {
                  setPublication(
                    checked
                      ? [...publication, origin]
                      : publication.filter((item) => item !== origin),
                  );
                }}
              />
            ))}
          <ListRow
            title={t("settings:mediaPublish")}
            disabled={busy || !publication.length}
            onPress={publish}
          />
        </ListGroup>
      )}
      {!!published?.length && (
        <ListGroup title={t("settings:mediaPublished")}>
          {published.map((origin) => (
            <ListRow key={origin} title={origin} />
          ))}
          <ListRow
            title={t("settings:mediaImport")}
            onPress={importPublished}
          />
        </ListGroup>
      )}
      {!!notice && <SettingsDescription>{notice}</SettingsDescription>}
    </Screen>
  );
}
