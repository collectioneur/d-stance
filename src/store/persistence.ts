import { useEffect, useRef } from "react";
import {
  createDefaultRoot,
  zeroCounters,
  type SceneRoot,
  type ShapeType,
  useSceneStore,
} from "./sceneStore";
import { temporalStore } from "./sceneStore";
import { isImageSdfDataUrl } from "../utils/imageSdf";

/** v5: layers may carry `image.sdf` (baked PNG data URL) for shapeType "image". */
const SCHEMA_VERSION = 5;
/** v4 is a strict subset of v5 (no image layers), so it loads as-is. */
const ACCEPTED_VERSIONS = new Set([4, SCHEMA_VERSION]);
const LS_KEY = "d-stance_scene";

export type PersistedScene = {
  v: number;
  root: SceneRoot;
  counters: Record<ShapeType, number>;
  groupCounter: number;
};

type LooseItem = {
  kind: string;
  shapeType?: unknown;
  scale?: unknown;
  image?: unknown;
  items?: unknown;
};

/**
 * Additive migration: layers persisted before the scale feature lack the
 * `scale` field. Fill defaults and sanitize (trust boundary — hash/LS data is
 * user-editable; a zero component would divide by zero in the shader).
 * Image layers must carry a well-formed baked SDF; otherwise the layer is
 * dropped rather than rendered from garbage.
 */
function normalizePersisted(s: PersistedScene): PersistedScene {
  const hasValidImage = (item: LooseItem) =>
    typeof item.image === "object" &&
    item.image !== null &&
    isImageSdfDataUrl((item.image as { sdf?: unknown }).sdf);

  const fixItems = (itemsIn: LooseItem[]): LooseItem[] => {
    const items = itemsIn.filter(
      (item) => item.kind !== "layer" || item.shapeType !== "image" || hasValidImage(item),
    );
    for (const item of items) {
      if (item.kind === "layer" && item.shapeType !== "image") delete item.image;
      const valid =
        Array.isArray(item.scale) &&
        item.scale.length === 3 &&
        item.scale.every((n) => typeof n === "number" && Number.isFinite(n));
      if (!valid) {
        item.scale = [1, 1, 1];
      } else {
        item.scale = (item.scale as number[]).map((n) =>
          Math.max(0.01, Math.abs(n)),
        );
      }
      if (item.kind === "group" && Array.isArray(item.items)) {
        item.items = fixItems(item.items as LooseItem[]);
      }
    }
    return items;
  };
  if (Array.isArray(s.root?.items)) {
    s.root.items = fixItems(s.root.items as LooseItem[]) as SceneRoot["items"];
  }
  return s;
}

export function encodeHash(s: PersistedScene): string {
  const json = JSON.stringify(s);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function decodeHash(raw: string): PersistedScene | null {
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!ACCEPTED_VERSIONS.has(parsed?.v)) return null;
    return normalizePersisted(parsed as PersistedScene);
  } catch {
    return null;
  }
}

function loadFromStorage(): PersistedScene | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const fromLS = JSON.parse(raw) as PersistedScene;
      if (ACCEPTED_VERSIONS.has(fromLS?.v)) return normalizePersisted(fromLS);
    }
  } catch {
    // ignore
  }
  return null;
}

export function loadInitialState(): Partial<PersistedScene> {
  const hash = window.location.hash.slice(1);
  if (hash) {
    const fromUrl = decodeHash(hash);
    if (fromUrl) return fromUrl;
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return loadFromStorage() ?? {};
}

function applyScene(scene: PersistedScene) {
  useSceneStore.setState({
    root: scene.root,
    counters: { ...zeroCounters(), ...scene.counters },
    groupCounter: scene.groupCounter,
    selectedContainerId: scene.root.id,
    selectedItemId: null,
    rootSelected: false,
  });
  temporalStore.getState().clear();
}

export function usePersistence(): void {
  const lastWrittenHash = useRef<string>("");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const unsub = useSceneStore.subscribe((state) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const persisted: PersistedScene = {
          v: SCHEMA_VERSION,
          root: state.root,
          counters: state.counters,
          groupCounter: state.groupCounter,
        };
        const encoded = encodeHash(persisted);
        lastWrittenHash.current = encoded;
        location.replace("#" + encoded);
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(persisted));
        } catch {
          // ignore quota errors
        }
      }, 1000);
    });

    function onHashChange() {
      const hash = window.location.hash.slice(1);
      if (hash === lastWrittenHash.current) return;

      const fromUrl = decodeHash(hash);
      if (fromUrl) {
        lastWrittenHash.current = hash;
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(fromUrl));
        } catch {
          // ignore
        }
        applyScene(fromUrl);
        return;
      }

      const fromLS = loadFromStorage();
      if (fromLS) {
        applyScene(fromLS);
      } else {
        const root = createDefaultRoot();
        useSceneStore.setState({
          root,
          counters: zeroCounters(),
          groupCounter: 0,
          selectedContainerId: root.id,
          selectedItemId: null,
          rootSelected: false,
        });
        temporalStore.getState().clear();
      }
    }

    window.addEventListener("hashchange", onHashChange);

    return () => {
      unsub();
      clearTimeout(timer);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);
}
