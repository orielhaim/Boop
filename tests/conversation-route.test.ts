import { expect, test } from "bun:test";
import {
  conversationWindowActive,
  marmotChatScene,
  profileElementId,
} from "../src/core/marmot/conversation-route";

const chat = {
  key: "conversation",
  name: "chat/[key]",
  params: { key: "marmot-ab" },
};
const details = {
  ...chat,
  key: "details",
  params: { ...chat.params, view: "details" },
};
const edit = {
  ...details,
  key: "edit",
  params: { ...details.params, view: "edit" },
};
const player = { key: "player", name: "audio-player" };

test("profile bounds are independent ungrouped elements", () => {
  expect(profileElementId("group:ab", "avatar")).toBe(
    "profile-morph-group-ab-avatar",
  );
  expect(profileElementId("group:ab", "name")).toBe(
    "profile-morph-group-ab-name",
  );
  expect(profileElementId("person:ab", "avatar")).toBe(
    "profile-morph-person-ab-avatar",
  );
});

test("one window covers a chat, its profile and its settings", () => {
  const routes = [chat, details, edit, player];
  for (const index of [0, 1, 2, 3])
    expect(conversationWindowActive({ routes, index }, chat.key, "ab")).toBe(
      true,
    );
  expect(marmotChatScene(chat)?.kind).toBe("conversation");
  expect(marmotChatScene(edit)?.kind).toBe("overlay");
});

test("a direct chat keeps its window behind the profile it opened", () => {
  const profile = {
    key: "profile",
    name: "person/[key]",
    params: { key: "peer", profileMorph: "person:peer" },
  };
  expect(
    conversationWindowActive(
      { routes: [chat, profile], index: 1 },
      chat.key,
      "ab",
    ),
  ).toBe(true);
  expect(
    conversationWindowActive(
      { routes: [chat, details, profile], index: 2 },
      chat.key,
      "ab",
    ),
  ).toBe(false);
  expect(
    conversationWindowActive(
      {
        routes: [
          chat,
          { ...profile, params: { key: "peer", profileMorph: "person:other" } },
        ],
        index: 1,
      },
      chat.key,
      "ab",
    ),
  ).toBe(false);
});

test("unrelated screens and another chat instance release the window", () => {
  const otherGroup = {
    ...details,
    params: { ...details.params, key: "marmot-cd" },
  };
  const secondChat = { ...chat, key: "another-conversation" };
  const person = { key: "person", name: "person/[key]" };
  for (const routes of [
    [chat, otherGroup],
    [chat, secondChat, details],
    [chat, details, person, player],
    [details, edit],
  ])
    expect(
      conversationWindowActive(
        { routes, index: routes.length - 1 },
        chat.key,
        "ab",
      ),
    ).toBe(false);
});
