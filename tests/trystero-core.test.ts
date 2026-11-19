import { expect, test } from "bun:test";
import type { BaseRoomConfig, PeerHandle } from "@trystero-p2p/core";

test("Trystero waits for the native SDP before activating an already-open data channel", async () => {
  const moduleUrl = new URL(
    "./peer.mjs",
    import.meta.resolve("@trystero-p2p/core"),
  );
  const {
    default: createPeer,
  }: {
    default: (initiator: boolean, config: BaseRoomConfig) => PeerHandle;
  } = await import(moduleUrl.href);
  const applied = Promise.withResolvers<void>();
  const events: string[] = [];
  const description = "a=fingerprint:sha-256 AA:BB\r\n";

  class NativePeer extends EventTarget {
    signalingState = "stable";
    connectionState = "new";
    localDescription?: RTCSessionDescriptionInit;
    remoteDescription?: RTCSessionDescriptionInit;
    channel = {
      readyState: "connecting",
      onopen: () => undefined,
      close() {
        this.readyState = "closed";
      },
    };

    createDataChannel() {
      return this.channel;
    }

    async setLocalDescription() {
      this.localDescription = { type: "offer", sdp: description };
    }

    async setRemoteDescription(answer: RTCSessionDescriptionInit) {
      this.channel.readyState = "open";
      this.channel.onopen();
      await applied.promise;
      this.remoteDescription = answer;
    }

    close() {
      this.connectionState = "closed";
    }
  }

  const peer = createPeer(true, {
    appId: "test",
    rtcPolyfill: NativePeer as unknown as typeof RTCPeerConnection,
  });
  try {
    expect(await peer.getOffer()).toEqual({ type: "offer", sdp: description });
    peer.setHandlers({
      connect: () => {
        events.push("verified setup can start");
      },
    });
    const answer = peer.signal({ type: "answer", sdp: description });
    expect(events).toEqual([]);
    applied.resolve();
    await answer;
    expect(events).toEqual(["verified setup can start"]);
  } finally {
    applied.resolve();
    peer.destroy();
  }
});
