import { describe, expect, test } from "vitest";
import { decodeHash, encodeHash, SCHEMA_VERSION, type PersistedScene } from "./persistence";
import { zeroCounters } from "./sceneStore";
import { FAKE_IMAGE_SDF, group, kitchenSink, scene, shape } from "../test/fixtures";

function blob(v: number, root: PersistedScene["root"]): string {
  return encodeHash({ v, root, counters: zeroCounters(), groupCounter: 0 });
}

function rawBlob(obj: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));
}

describe("persistence", () => {
  test("round-trips the current schema", () => {
    const root = kitchenSink();
    const decoded = decodeHash(blob(SCHEMA_VERSION, root));
    expect(decoded?.root).toEqual(root);
  });

  test("accepts old v4/v5 blobs", () => {
    const root = scene([shape("sphere", { id: "a" })]);
    expect(decodeHash(blob(4, root))?.root.items).toHaveLength(1);
    expect(decodeHash(blob(5, root))?.root.items).toHaveLength(1);
  });

  test("rejects unknown versions and garbage", () => {
    const root = scene([shape("sphere")]);
    expect(decodeHash(blob(3, root))).toBeNull();
    expect(decodeHash(blob(999, root))).toBeNull();
    expect(decodeHash("not base64 at all!!")).toBeNull();
    expect(decodeHash(rawBlob(null))).toBeNull();
    expect(decodeHash(rawBlob("string"))).toBeNull();
  });

  test("fills missing scale and clamps hostile scale", () => {
    const s = shape("box", { id: "a" }) as unknown as Record<string, unknown>;
    delete s.scale;
    const z = shape("box", { id: "b", scale: [0, -3, 1e-9] });
    const bad = shape("box", { id: "c" }) as unknown as Record<string, unknown>;
    bad.scale = ["x", null, 1];
    const decoded = decodeHash(
      rawBlob({ v: SCHEMA_VERSION, root: { id: "r", name: "S", items: [s, z, bad] }, counters: {}, groupCounter: 0 }),
    );
    const items = decoded!.root.items;
    expect(items[0].scale).toEqual([1, 1, 1]);
    expect(items[1].scale).toEqual([0.01, 3, 0.01]);
    expect(items[2].scale).toEqual([1, 1, 1]);
  });

  test("drops image layers without a valid baked SDF", () => {
    const good = shape("image", { id: "good", image: { sdf: FAKE_IMAGE_SDF } });
    const bad = shape("image", { id: "bad", image: { sdf: "javascript:alert(1)" } });
    const none = shape("image", { id: "none" });
    const decoded = decodeHash(blob(SCHEMA_VERSION, scene([good, bad, none])));
    expect(decoded!.root.items.map((i) => i.id)).toEqual(["good"]);
  });

  test("strips image payload from non-image layers and bad round values", () => {
    const sphere = shape("sphere", { id: "s" }) as unknown as Record<string, unknown>;
    sphere.image = { sdf: FAKE_IMAGE_SDF };
    const img = shape("image", { id: "i", image: { sdf: FAKE_IMAGE_SDF, round: -1 } });
    const decoded = decodeHash(blob(SCHEMA_VERSION, scene([sphere as never, img])));
    const [s, i] = decoded!.root.items;
    expect("image" in s).toBe(false);
    expect((i as { image: { round?: number } }).image.round).toBeUndefined();
  });
});

describe("persistence v7 materials", () => {
  test("keeps valid materials and clamps hostile ones", () => {
    const ok = shape("sphere", { id: "ok", material: { color: [0.1, 0.2, 0.3], roughness: 0.4, metalness: 1, emission: 2 } });
    const bad = shape("box", { id: "bad" }) as unknown as Record<string, unknown>;
    bad.material = { color: [9, -1, "x"], roughness: NaN, metalness: 5, emission: 1e9 };
    const junk = shape("box", { id: "junk" }) as unknown as Record<string, unknown>;
    junk.material = "red";
    const g = group([], { id: "g" }) as unknown as Record<string, unknown>;
    g.material = { color: [0, 1, 0] };
    const decoded = decodeHash(blob(SCHEMA_VERSION, scene([ok, bad as never, junk as never, g as never])));
    const [a, b, c, d] = decoded!.root.items;
    expect(a.material).toEqual({ color: [0.1, 0.2, 0.3], roughness: 0.4, metalness: 1, emission: 2 });
    expect(b.material).toEqual({ color: [1, 0, 0.72], roughness: 0.5, metalness: 1, emission: 10 });
    expect("material" in c).toBe(false);
    expect(d.material).toEqual({ color: [0, 1, 0], roughness: 0.5, metalness: 0, emission: 0 });
  });

  test("v6 blobs (no materials) still load", () => {
    const decoded = decodeHash(blob(6, scene([shape("sphere", { id: "a" })])));
    expect(decoded?.root.items[0].material).toBeUndefined();
  });
});

describe("persistence v8 modifiers", () => {
  test("keeps valid modifier stacks, drops junk", () => {
    const a = shape("sphere", { id: "a", modifiers: [{ kind: "repeat", spacing: [1, 1, 1], count: [3, 1, 1] }] });
    const b = shape("box", { id: "b" }) as unknown as Record<string, unknown>;
    b.modifiers = [{ kind: "nope" }, { kind: "round", radius: -2 }];
    const c = shape("box", { id: "c" }) as unknown as Record<string, unknown>;
    c.modifiers = "twist";
    const decoded = decodeHash(blob(SCHEMA_VERSION, scene([a, b as never, c as never])));
    const [x, y, z] = decoded!.root.items;
    expect(x.modifiers).toEqual([{ kind: "repeat", spacing: [1, 1, 1], count: [3, 1, 1] }]);
    expect(y.modifiers).toEqual([{ kind: "round", radius: 0 }]);
    expect("modifiers" in z).toBe(false);
  });

  test("v7 blobs still load", () => {
    expect(decodeHash(blob(7, scene([shape("sphere")])))?.root.items).toHaveLength(1);
  });
});
