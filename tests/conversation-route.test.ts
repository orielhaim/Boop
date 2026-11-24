import { expect, test } from "bun:test";
import {
  conversationWindowActive,
  marmotChatScene,
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

test("one window covers a chat, its profile and its settings", () => {
  const routes = [chat, details, edit, player];
  for (const index of [0, 1, 2, 3])
    expect(conversationWindowActive({ routes, index }, chat.key, "ab")).toBe(
      true,
    );
  expect(marmotChatScene(chat)?.kind).toBe("conversation");
  expect(marmotChatScene(edit)?.kind).toBe("overlay");
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
