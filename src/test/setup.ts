/**
 * Minimal browser globals for unit tests in node. sceneStore loads the saved
 * scene from `location.hash` / localStorage at import time; tests start empty.
 */
const store = new Map<string, string>();

const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
g.location = { hash: "", pathname: "/", search: "", replace: () => {} };
g.history = { replaceState: () => {} };
g.window = globalThis;
