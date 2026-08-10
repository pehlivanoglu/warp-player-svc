import { RollingBitrate } from "./metrics";

describe("RollingBitrate", () => {
  it("counts only encoded bytes in the trailing second", () => {
    const rate = new RollingBitrate();
    rate.add(100, 1000);
    rate.add(200, 1500);
    rate.add(300, 2100);

    expect(rate.bitrate(2100)).toBe((200 + 300) * 8);
    rate.clear();
    expect(rate.bitrate(2100)).toBe(0);
  });
});
