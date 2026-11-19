export function callMetric(
  stage: string,
  values: Record<string, string | number | boolean> = {},
) {
  if (typeof __DEV__ !== "undefined" && __DEV__)
    console.info("[call timing]", {
      stage,
      at: Math.round(performance.now()),
      ...values,
    });
}

export async function traceAudioPackets(
  connection: RTCPeerConnection,
  signal: AbortSignal,
) {
  if (typeof __DEV__ === "undefined" || !__DEV__) return;
  let sent = false;
  let received = false;
  const deadline = performance.now() + 8_000;
  while (!signal.aborted && performance.now() < deadline) {
    const stats = await connection.getStats().catch(() => null);
    if (!stats || signal.aborted) return;
    for (const row of stats.values()) {
      if (row.kind !== "audio") continue;
      if (!sent && row.type === "outbound-rtp" && row.packetsSent > 0) {
        sent = true;
        callMetric("first_outbound_audio_packet", { packets: row.packetsSent });
      }
      if (!received && row.type === "inbound-rtp" && row.packetsReceived > 0) {
        received = true;
        callMetric("first_inbound_audio_packet", {
          packets: row.packetsReceived,
          lost: Number(row.packetsLost) || 0,
          jitter: Number(row.jitter) || 0,
        });
      }
    }
    if (sent && received) {
      for (const row of stats.values()) {
        if (row.type !== "transport") continue;
        const pair = stats.get(row.selectedCandidatePairId);
        if (!pair) continue;
        callMetric("selected_ice_pair", {
          localType:
            stats.get(pair.localCandidateId)?.candidateType ?? "unknown",
          remoteType:
            stats.get(pair.remoteCandidateId)?.candidateType ?? "unknown",
          rtt: Number(pair.currentRoundTripTime) || 0,
          dtls: row.dtlsState ?? "unknown",
        });
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!signal.aborted)
    callMetric("audio_packet_observation_ended", { sent, received });
}
