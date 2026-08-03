import { jest } from "@jest/globals";

import { MOQObject } from "../transport/tracks";
import { WarpTrack } from "../warpcatalog";

import { Av1SvcAssembler } from "./av1svc";

const tracks: WarpTrack[] = [0, 1, 2].map((spatialId) => ({
  name: `layer-${spatialId}`,
  namespace: "live",
  spatialId,
}));

function varint(value: bigint): Uint8Array {
  if (value <= 0x3fn) {
    return new Uint8Array([Number(value)]);
  }
  if (value <= 0x3fffn) {
    return new Uint8Array([
      0x40 | Number((value >> 8n) & 0x3fn),
      Number(value & 0xffn),
    ]);
  }
  if (value <= 0x3fffffffn) {
    return new Uint8Array([
      0x80 | Number((value >> 24n) & 0x3fn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ]);
  }
  throw new Error("test value too large");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function object(
  sid: number,
  objectId = 0n,
  independent = true,
  timestamp = 1000n,
  flags = 0xc0,
): MOQObject {
  const marking =
    (BigInt(flags | (independent ? 0x20 : 0)) << 8n) | BigInt(sid);
  return {
    trackAlias: BigInt(sid),
    location: { group: 7n, object: objectId },
    data: new Uint8Array([sid + 1]),
    extensions: concat(
      varint(0x04n),
      varint(marking),
      varint(0x06n),
      varint(timestamp),
    ),
  };
}

describe("Av1SvcAssembler", () => {
  afterEach(() => jest.useRealTimers());

  it("assembles out-of-order layers in ascending spatial order", () => {
    const output: MOQObject[] = [];
    const assembler = new Av1SvcAssembler(tracks, {
      maxWaitMs: 100,
      onObject: (value) => output.push(value),
    });

    assembler.push(tracks[2], object(2));
    assembler.push(tracks[0], object(0));
    assembler.push(tracks[1], object(1));

    expect(output).toHaveLength(1);
    expect(Array.from(output[0].data)).toEqual([1, 2, 3]);
    expect(output[0].location).toEqual({ group: 7n, object: 0n });
    expect(output[0].trackAlias).toBe(2n);
  });

  it("ignores exact duplicates and rejects conflicting duplicates", () => {
    const output: MOQObject[] = [];
    const drops: string[] = [];
    const assembler = new Av1SvcAssembler(tracks, {
      maxWaitMs: 100,
      onObject: (value) => output.push(value),
      onDrop: (reason) => drops.push(reason),
    });
    const base = object(0);
    assembler.push(tracks[0], base);
    assembler.push(tracks[0], { ...base, data: new Uint8Array(base.data) });
    assembler.push(tracks[1], object(1));
    assembler.push(tracks[2], object(2));
    assembler.push(tracks[0], { ...base, data: new Uint8Array([9]) });

    expect(output).toHaveLength(1);
    expect(drops).toEqual([expect.stringContaining("conflicting duplicate")]);
  });

  it("rejects mismatched timestamps and independence flags", () => {
    const output: MOQObject[] = [];
    const drops: string[] = [];
    const assembler = new Av1SvcAssembler(tracks, {
      maxWaitMs: 100,
      onObject: (value) => output.push(value),
      onDrop: (reason) => drops.push(reason),
    });
    assembler.push(tracks[0], object(0));
    assembler.push(tracks[1], object(1, 0n, true, 1001n));
    assembler.push(tracks[2], object(2, 0n, false));

    expect(output).toHaveLength(0);
    expect(drops[0]).toMatch(/timestamps or independence/);
  });

  it.each([
    ["missing marking", undefined],
    ["wrong LID", object(2)],
    ["nonzero TID", object(0, 0n, false, 1000n, 0xc1)],
    ["unset S/E", object(0, 0n, false, 1000n, 0x00)],
  ])("rejects %s", (_name, invalid) => {
    const drops: string[] = [];
    const assembler = new Av1SvcAssembler(tracks, {
      maxWaitMs: 100,
      onObject: jest.fn(),
      onDrop: (reason) => drops.push(reason),
    });
    const value = invalid ?? { ...object(0), extensions: undefined };
    assembler.push(tracks[0], value);
    expect(drops).toHaveLength(1);
  });

  it("times out, suppresses deltas, and recovers on a complete keyframe", () => {
    jest.useFakeTimers();
    const output: MOQObject[] = [];
    const drops: string[] = [];
    const assembler = new Av1SvcAssembler(tracks, {
      maxWaitMs: 20,
      onObject: (value) => output.push(value),
      onDrop: (reason) => drops.push(reason),
    });
    assembler.push(tracks[0], object(0, 0n, true));
    jest.advanceTimersByTime(99);
    expect(drops).toHaveLength(0);
    jest.advanceTimersByTime(1);

    for (let sid = 0; sid < 3; sid++) {
      assembler.push(tracks[sid], object(sid, 1n, false));
    }
    expect(output).toHaveLength(0);

    for (let sid = 0; sid < 3; sid++) {
      assembler.push(tracks[sid], object(sid, 2n, true));
    }
    expect(output).toHaveLength(1);
    expect(output[0].location.object).toBe(2n);
    expect(drops).toEqual([
      expect.stringContaining("timed out"),
      expect.stringContaining("awaiting keyframe"),
    ]);
  });

  it("bounds pending state and clears timers on dispose", () => {
    jest.useFakeTimers();
    const drops: string[] = [];
    const assembler = new Av1SvcAssembler(tracks, {
      maxWaitMs: 100,
      maxPendingUnits: 1,
      onObject: jest.fn(),
      onDrop: (reason) => drops.push(reason),
    });
    assembler.push(tracks[0], object(0, 0n));
    assembler.push(tracks[0], object(0, 1n));
    expect(drops[0]).toMatch(/pending-unit limit/);
    assembler.dispose();
    jest.runAllTimers();
    expect(drops).toHaveLength(1);
  });
});
