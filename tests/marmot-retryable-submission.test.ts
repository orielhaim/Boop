import { describe, expect, it } from "bun:test";
import { retryableSubmission } from "@/core/marmot/retryable-submission";

describe("retryable submissions", () => {
  it("reuses the token and payload after a failed attempt", () => {
    const create = () => ({ token: "stable-token", body: "encrypted-once" });
    const first = retryableSubmission(undefined, "schedule-a", create);
    const retry = retryableSubmission(first, "schedule-a", () => {
      throw new Error("retry must retain the original request");
    });

    expect(retry).toBe(first);
    expect(retry.value).toEqual({
      token: "stable-token",
      body: "encrypted-once",
    });
  });

  it("starts a new token for a changed logical request", () => {
    const first = retryableSubmission(undefined, "message-a", () => "token-a");
    const next = retryableSubmission(first, "message-b", () => "token-b");

    expect(next).not.toBe(first);
    expect(next.value).toBe("token-b");
  });

  it("retains one asynchronous payload when an admission is retried", async () => {
    let encryptions = 0;
    const first = retryableSubmission(undefined, "schedule-a", async () => {
      encryptions += 1;
      return { token: "stable-token", body: "sealed-once" };
    });
    const retry = retryableSubmission(first, "schedule-a", async () => {
      encryptions += 1;
      return { token: "new-token", body: "sealed-again" };
    });

    expect(retry).toBe(first);
    expect(await retry.value).toEqual({
      token: "stable-token",
      body: "sealed-once",
    });
    expect(encryptions).toBe(1);
  });
});
