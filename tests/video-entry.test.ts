import { expect, test } from "bun:test";
import { isIncomingMediaIntentUri } from "../src/core/video/intent";
import { videoFile } from "../src/core/video/types";

test("incoming document intents accept provider URIs only", () => {
  expect(isIncomingMediaIntentUri("content://provider/document/42")).toBe(true);
  expect(isIncomingMediaIntentUri("https://example.com/video.mp4")).toBe(false);
  expect(isIncomingMediaIntentUri("file:///storage/video.mp4")).toBe(false);
  expect(isIncomingMediaIntentUri("content://provider")).toBe(false);
  expect(isIncomingMediaIntentUri("content://com.orielhaim.boop/files/1")).toBe(
    false,
  );
  expect(
    isIncomingMediaIntentUri(`content://provider/${"a".repeat(4090)}`),
  ).toBe(false);
});

test("video source classification prefers MIME and falls back to known extensions", () => {
  expect(videoFile("movie", "video/mp4; codecs=h264")).toBe(true);
  expect(videoFile("movie.mkv", "application/octet-stream")).toBe(true);
  expect(videoFile("movie.mkv", "application/x-matroska")).toBe(true);
  expect(videoFile("movie.mp4", "audio/mpeg")).toBe(false);
  expect(videoFile("document.pdf", "application/octet-stream")).toBe(false);
});
