import {
  MSF_SUPPORTED_VERSION,
  WarpCatalog,
  WarpCatalogManager,
  WarpTrack,
  resolveAv1SvcDependencyChain,
} from "./warpcatalog";

describe("WarpCatalogManager draft-01 init data", () => {
  const catalog: WarpCatalog = {
    version: "draft-01",
    tracks: [
      {
        name: "video",
        namespace: "cmsf/clear",
        packaging: "cmaf",
        role: "video",
        initRef: "init-video",
      },
      {
        name: "video_locmaf",
        namespace: "cmsf/clear",
        packaging: "locmaf",
        locmafVersion: "0.3",
        role: "video",
        initRef: "init-video",
      },
      {
        name: "loc-only",
        namespace: "msf/clear",
        packaging: "loc",
        role: "video",
      },
    ],
    initDataList: [{ id: "init-video", type: "inline", data: "QUJD" }],
  };

  it("parses the draft-01 string version", () => {
    expect(typeof catalog.version).toBe("string");
    expect(catalog.version).toBe(MSF_SUPPORTED_VERSION);
  });

  it("accepts a draft-01 catalog", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);
    expect(mgr.getCatalog()).not.toBeNull();
  });

  it("rejects a catalog with an unsupported version", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData({ ...catalog, version: "1" });
    expect(mgr.getCatalog()).toBeNull();
  });

  it("resolves a track initRef to the shared init data entry", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);

    const cmaf = catalog.tracks[0];
    const locmaf = catalog.tracks[1];

    // The CMAF and LOCMAF variants share one initDataList entry.
    expect(cmaf.initRef).toBe(locmaf.initRef);
    expect(mgr.getInitData(cmaf)).toBe("QUJD");
    expect(mgr.getInitData(locmaf)).toBe("QUJD");
  });

  it("returns undefined for a track without initRef", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);
    expect(mgr.getInitData(catalog.tracks[2])).toBeUndefined();
  });

  it("returns undefined for an unresolved initRef", () => {
    const mgr = new WarpCatalogManager();
    mgr.handleCatalogData(catalog);
    expect(mgr.getInitData({ name: "x", initRef: "missing" })).toBeUndefined();
  });
});

describe("resolveAv1SvcDependencyChain", () => {
  const tracks: WarpTrack[] = [
    {
      name: "base",
      namespace: "live",
      packaging: "loc",
      role: "video",
      codec: "av01.0.08M.08",
      renderGroup: 1,
      framerate: 25,
      spatialId: 0,
    },
    {
      name: "middle",
      namespace: "live",
      packaging: "loc",
      role: "video",
      codec: "av01.0.08M.08",
      renderGroup: 1,
      framerate: 25,
      spatialId: 1,
      depends: ["base"],
    },
    {
      name: "top",
      namespace: "live",
      packaging: "loc",
      role: "video",
      codec: "av01.0.08M.08",
      renderGroup: 1,
      framerate: 25,
      spatialId: 2,
      depends: ["middle"],
    },
  ];
  const catalog: WarpCatalog = { version: "draft-01", tracks };

  it.each([
    [0, ["base"]],
    [1, ["base", "middle"]],
    [2, ["base", "middle", "top"]],
  ])("resolves the layer %i closure", (index, names) => {
    expect(resolveAv1SvcDependencyChain(catalog, tracks[index])).toEqual(
      names.map((name) => expect.objectContaining({ name })),
    );
  });

  it("leaves ordinary tracks unchanged", () => {
    const ordinary = { name: "video", packaging: "loc", codec: "av01" };
    expect(resolveAv1SvcDependencyChain(catalog, ordinary)).toEqual([ordinary]);
  });

  it.each([
    ["missing dependency", { ...tracks[2], depends: ["missing"] }],
    ["SID gap", { ...tracks[2], depends: ["base"] }],
    ["codec mismatch", { ...tracks[2], codec: "av01.other" }],
    ["render-group mismatch", { ...tracks[2], renderGroup: 2 }],
    ["framerate mismatch", { ...tracks[2], framerate: 30 }],
  ])("rejects %s", (_name, selected) => {
    expect(() => resolveAv1SvcDependencyChain(catalog, selected)).toThrow();
  });

  it("rejects cross-namespace dependencies", () => {
    const selected = { ...tracks[1], depends: ["foreign"] };
    const foreign = { ...tracks[0], name: "foreign", namespace: "other" };
    expect(() =>
      resolveAv1SvcDependencyChain(
        { ...catalog, tracks: [...tracks, foreign] },
        selected,
      ),
    ).toThrow(/crosses namespaces/);
  });

  it("rejects dependency cycles", () => {
    const base = { ...tracks[0], depends: ["middle"] };
    const middle = { ...tracks[1], depends: ["base"] };
    expect(() =>
      resolveAv1SvcDependencyChain(
        { ...catalog, tracks: [base, middle] },
        middle,
      ),
    ).toThrow();
  });

  it("rejects duplicate dependency tracks", () => {
    expect(() =>
      resolveAv1SvcDependencyChain(
        { ...catalog, tracks: [...tracks, { ...tracks[0] }] },
        tracks[1],
      ),
    ).toThrow(/duplicated/);
  });
});
