import { beforeEach, describe, expect, test } from "vitest";
import {
  ALL_SHAPE_TYPES,
  MAX_INSTRUCTIONS,
  MAX_TRANSFORM_DEPTH,
  countInstructions,
  createDefaultRoot,
  findItem,
  redoScene,
  temporalStore,
  undoScene,
  useSceneStore,
  validateRoot,
  zeroCounters,
} from "./sceneStore";
import { group, kitchenSink, scene, shape } from "../test/fixtures";

function reset() {
  const root = createDefaultRoot();
  useSceneStore.setState({
    root,
    counters: zeroCounters(),
    groupCounter: 0,
    selectedContainerId: root.id,
    selectedItemId: null,
    selectedIds: [],
    rootSelected: false,
  });
  temporalStore.getState().clear();
}

describe("scene store", () => {
  beforeEach(reset);

  test("adds every shape type to the root", () => {
    const s = useSceneStore.getState();
    for (const t of ALL_SHAPE_TYPES) {
      if (t === "image") continue; // needs a baked SDF
      expect(s.addShapeToContainer(useSceneStore.getState().root.id, t)).toBe(true);
    }
    expect(useSceneStore.getState().root.items).toHaveLength(ALL_SHAPE_TYPES.length - 1);
  });

  test("image layers require an image payload and vice versa", () => {
    const { root, addShapeToContainer } = useSceneStore.getState();
    expect(addShapeToContainer(root.id, "image")).toBe(false);
    expect(addShapeToContainer(root.id, "sphere", { sdf: "x" })).toBe(false);
  });

  test("new shape is selected and named with a counter", () => {
    const { root, addShapeToContainer } = useSceneStore.getState();
    addShapeToContainer(root.id, "box");
    addShapeToContainer(root.id, "box");
    const st = useSceneStore.getState();
    expect(st.root.items.map((i) => i.name)).toEqual(["Box 1", "Box 2"]);
    expect(st.selectedItemId).toBe(st.root.items[1].id);
  });

  test("undo/redo restores the tree and clears selection", () => {
    const { root, addShapeToContainer } = useSceneStore.getState();
    addShapeToContainer(root.id, "sphere");
    addShapeToContainer(root.id, "box");
    undoScene();
    expect(useSceneStore.getState().root.items).toHaveLength(1);
    expect(useSceneStore.getState().selectedItemId).toBeNull();
    redoScene();
    expect(useSceneStore.getState().root.items).toHaveLength(2);
  });

  test("duplicate copies subtrees with fresh ids", () => {
    useSceneStore.setState({ root: kitchenSink() });
    const before = useSceneStore.getState().root;
    expect(useSceneStore.getState().duplicateItems(["g1"])).toBeNull();
    const after = useSceneStore.getState().root;
    expect(after.items.length).toBe(before.items.length + 1);
    const copy = after.items[3];
    expect(copy.kind).toBe("group");
    expect(copy.id).not.toBe("g1");
    const ids = new Set<string>();
    const walk = (items: typeof after.items) =>
      items.forEach((i) => {
        expect(ids.has(i.id)).toBe(false);
        ids.add(i.id);
        if (i.kind === "group") walk(i.items);
      });
    walk(after.items);
  });

  test("remove drops the subtree and the selection", () => {
    useSceneStore.setState({ root: kitchenSink() });
    useSceneStore.getState().setSelection(["t1"], "t1");
    useSceneStore.getState().removeItems(["g1"]);
    const st = useSceneStore.getState();
    expect(findItem(st.root, "g1")).toBeNull();
    expect(findItem(st.root, "t1")).toBeNull();
    expect(st.selectedItemId).toBeNull();
  });

  test("move into own child is rejected", () => {
    useSceneStore.setState({ root: kitchenSink() });
    expect(useSceneStore.getState().moveItems(["g1"], "g2", 0)).toBe(false);
  });

  test("caps: instruction budget and nesting depth", () => {
    const many = scene(Array.from({ length: 200 }, () => shape("sphere")));
    expect(countInstructions(many.items)).toBeGreaterThan(MAX_INSTRUCTIONS);
    expect(validateRoot(many)).toBe("cap");

    let deep = group([shape("sphere")]);
    for (let i = 0; i < MAX_TRANSFORM_DEPTH; i++) deep = group([deep]);
    expect(validateRoot(scene([deep]))).toBe("depth");
  });
});
