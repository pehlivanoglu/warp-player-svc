import { MOQObject } from "../transport/tracks";
import { WarpTrack } from "../warpcatalog";

import {
  LocFrameMarking,
  getLocCaptureTimestampUs,
  getLocFrameMarking,
} from "./extensions";

interface LayerObject {
  object: MOQObject;
  marking: LocFrameMarking;
  timestamp: bigint | null;
}

interface PendingUnit {
  key: string;
  group: bigint;
  object: bigint;
  layers: Map<number, LayerObject>;
  timer: ReturnType<typeof setTimeout>;
}

export interface Av1SvcAssemblerOptions {
  maxWaitMs: number;
  onObject: (object: MOQObject) => void;
  onDrop?: (reason: string) => void;
  maxPendingUnits?: number;
  waitForIndependent?: boolean;
}

/** Reassembles LOC AV1 spatial layers into temporal units. */
export class Av1SvcAssembler {
  private readonly tracks: WarpTrack[];
  private readonly trackIds = new Map<string, number>();
  private readonly pending = new Map<string, PendingUnit>();
  private readonly finished = new Map<string, Map<number, LayerObject>>();
  private readonly finishedOrder: string[] = [];
  private readonly waitMs: number;
  private readonly maxPending: number;
  private awaitingIndependent: boolean;
  private disposed = false;

  constructor(
    tracks: WarpTrack[],
    private readonly options: Av1SvcAssemblerOptions,
  ) {
    this.tracks = [...tracks].sort(
      (a, b) => (a.spatialId as number) - (b.spatialId as number),
    );
    this.waitMs = Math.max(100, options.maxWaitMs);
    this.maxPending = Math.max(1, options.maxPendingUnits ?? 64);
    this.awaitingIndependent = options.waitForIndependent ?? false;
    for (const track of this.tracks) {
      this.trackIds.set(trackKey(track), track.spatialId as number);
    }
  }

  public push(track: WarpTrack, object: MOQObject): void {
    if (this.disposed) {
      return;
    }
    const sid = this.trackIds.get(trackKey(track));
    if (sid === undefined) {
      this.drop(`unexpected SVC track ${track.name}`);
      return;
    }

    const key = locationKey(object);
    let layer: LayerObject;
    try {
      const marking = getLocFrameMarking(object.extensions);
      if (!marking) {
        throw new Error("missing LOC frame marking");
      }
      validateMarking(marking, sid);
      layer = {
        object,
        marking,
        timestamp: getLocCaptureTimestampUs(object.extensions),
      };
    } catch (error) {
      this.invalidate(
        key,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const finished = this.finished.get(key);
    if (finished) {
      const previous = finished.get(sid);
      if (!previous || !sameLayer(previous, layer)) {
        this.drop(`conflicting duplicate for ${key} layer ${sid}`);
      }
      return;
    }

    let unit = this.pending.get(key);
    if (!unit) {
      unit = {
        key,
        group: object.location.group,
        object: object.location.object,
        layers: new Map(),
        timer: setTimeout(() => this.expire(key), this.waitMs),
      };
      this.pending.set(key, unit);
    }

    const previous = unit.layers.get(sid);
    if (previous) {
      if (!sameLayer(previous, layer)) {
        this.invalidate(key, `conflicting duplicate layer ${sid}`);
      }
      return;
    }
    unit.layers.set(sid, layer);

    while (this.pending.size > this.maxPending) {
      const oldest = this.sortedPending()[0];
      this.invalidate(oldest.key, "pending-unit limit exceeded");
    }
    this.drain();
  }

  public dispose(): void {
    this.disposed = true;
    for (const unit of this.pending.values()) {
      clearTimeout(unit.timer);
    }
    this.pending.clear();
    this.finished.clear();
    this.finishedOrder.length = 0;
  }

  private drain(): void {
    while (!this.disposed) {
      const unit = this.sortedPending()[0];
      if (!unit || unit.layers.size !== this.tracks.length) {
        return;
      }
      clearTimeout(unit.timer);
      this.pending.delete(unit.key);

      const layers = this.tracks.map((track) =>
        unit.layers.get(track.spatialId as number),
      ) as LayerObject[];
      const timestamp = layers[0].timestamp;
      const independent = layers[0].marking.independent;
      if (
        layers.some(
          (layer) =>
            layer.timestamp !== timestamp ||
            layer.marking.independent !== independent,
        )
      ) {
        this.reject(unit, "layer timestamps or independence flags differ");
        continue;
      }

      this.rememberFinished(unit.key, unit.layers);
      if (this.awaitingIndependent && !independent) {
        this.drop(`dropping delta ${unit.key} while awaiting keyframe`);
        continue;
      }
      if (independent) {
        this.awaitingIndependent = false;
      }

      const selected = layers[layers.length - 1].object;
      const size = layers.reduce(
        (total, layer) => total + layer.object.data.length,
        0,
      );
      const data = new Uint8Array(size);
      let offset = 0;
      for (const layer of layers) {
        data.set(layer.object.data, offset);
        offset += layer.object.data.length;
      }
      this.options.onObject({ ...selected, data });
    }
  }

  private expire(key: string): void {
    if (this.pending.has(key)) {
      this.invalidate(key, "timed out waiting for spatial layers");
    }
  }

  private invalidate(key: string, reason: string): void {
    const unit = this.pending.get(key);
    if (unit) {
      clearTimeout(unit.timer);
      this.pending.delete(key);
      this.rememberFinished(key, unit.layers);
    } else {
      this.rememberFinished(key, new Map());
    }
    this.awaitingIndependent = true;
    this.drop(`invalid SVC unit ${key}: ${reason}`);
    this.drain();
  }

  private reject(unit: PendingUnit, reason: string): void {
    this.rememberFinished(unit.key, unit.layers);
    this.awaitingIndependent = true;
    this.drop(`invalid SVC unit ${unit.key}: ${reason}`);
  }

  private rememberFinished(
    key: string,
    layers: Map<number, LayerObject>,
  ): void {
    if (this.finished.has(key)) {
      return;
    }
    this.finished.set(key, new Map(layers));
    this.finishedOrder.push(key);
    while (this.finishedOrder.length > this.maxPending * 2) {
      const expired = this.finishedOrder.shift();
      if (expired) {
        this.finished.delete(expired);
      }
    }
  }

  private sortedPending(): PendingUnit[] {
    return [...this.pending.values()].sort((a, b) => {
      if (a.group !== b.group) {
        return a.group < b.group ? -1 : 1;
      }
      return a.object === b.object ? 0 : a.object < b.object ? -1 : 1;
    });
  }

  private drop(reason: string): void {
    this.options.onDrop?.(reason);
  }
}

function trackKey(track: WarpTrack): string {
  return `${track.namespace ?? ""}\u0000${track.name}`;
}

function locationKey(object: MOQObject): string {
  return `${object.location.group}:${object.location.object}`;
}

function validateMarking(marking: LocFrameMarking, sid: number): void {
  if (!marking.start || !marking.end) {
    throw new Error("frame marking must set S and E");
  }
  if (
    marking.discardable ||
    marking.baseLayerSync ||
    marking.temporalId !== 0
  ) {
    throw new Error("unsupported frame-marking flags");
  }
  if (marking.layerId !== sid) {
    throw new Error(
      `frame-marking LID ${marking.layerId} does not match ${sid}`,
    );
  }
}

function sameLayer(a: LayerObject, b: LayerObject): boolean {
  if (
    a.timestamp !== b.timestamp ||
    a.marking.independent !== b.marking.independent ||
    a.object.trackAlias !== b.object.trackAlias ||
    a.object.status !== b.object.status ||
    a.object.location.group !== b.object.location.group ||
    a.object.location.object !== b.object.location.object
  ) {
    return false;
  }
  return (
    sameBytes(a.object.data, b.object.data) &&
    sameBytes(a.object.extensions, b.object.extensions)
  );
}

function sameBytes(
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
