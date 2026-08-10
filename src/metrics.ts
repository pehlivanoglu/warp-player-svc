export interface MediaMetricsSnapshot {
  schema_version: 1;
  sampled_at_unix_ms: number;
  client: "chrome" | "native";
  simulated: boolean;
  state:
    | "starting"
    | "receiving"
    | "buffering"
    | "playing"
    | "stalled"
    | "error";
  target_track: string | null;
  active_track: string | null;
  switch_state: "stable" | "waiting_independent";
  quality: {
    spatial_id: number | null;
    width: number | null;
    height: number | null;
  };
  e2e_latency_ms: number | null;
  player_bitrate_bps: number | null;
  receive_bitrate_bps: number;
  catalog_bitrate_bps: number | null;
  buffer_level_ms: number | null;
  playback_rate: number | null;
  stall_count: number;
  stall_duration_ms: number;
}

export class RollingBitrate {
  private samples: Array<{ at: number; bytes: number }> = [];

  add(bytes: number, at = Date.now()): void {
    this.samples.push({ at, bytes });
  }

  bitrate(at = Date.now()): number {
    const cutoff = at - 1000;
    this.samples = this.samples.filter((sample) => sample.at >= cutoff);
    return this.samples.reduce((sum, sample) => sum + sample.bytes, 0) * 8;
  }

  clear(): void {
    this.samples = [];
  }
}
