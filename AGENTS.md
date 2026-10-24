# d-stance

Browser-only 3D SDF editor. No backend. Scene is a CSG tree (shapes + groups + boolean ops). CPU bakes each shape into one inverse affine map; the scene compiler turns the tree's structure into WGSL and its numbers into a uniform value buffer; a fullscreen TypeGPU fragment shader raymarches the generated SDF.

Stack: React 19, Vite, TypeScript (`tsover` 5.9 — workspace TS, not the editor builtin), TypeGPU 0.12, Zustand + zundo.

Agents break this repo by desyncing **cross-file contracts**, not by missing a TypeGPU API. `tsc` does not catch most of those.

## Before you edit

| Touching | Read first |
|---|---|
| TypeGPU / `"use gpu"` | `.agents/skills/typegpu`. Never guess APIs. After GPU edits: `npm run inspect:gpu`. |
| New or changed primitive | `src/store/sceneStore.ts` + `src/sdf/primitives.ts` (WGSL / GLSL / TypeGPU source + `primitiveCall`) + `src/gpu/bounds.ts` (`shapeBoundRadius`) + `src/utils/commands.ts` |
| Transforms, gizmo, scale | `src/gpu/bake.ts` (composition order), `src/gpu/gizmo.ts` |
| Tree / DnD / add / remove | `src/scene/arboristAdapter.ts`, `countInstructions`, caps in `sceneStore.ts` |
| Scene SDF codegen / culling / pick / highlight | `src/gpu/sceneCompiler.ts` (+ its tests) and the program cache in `src/gpu/useGpu.ts` |
| Save / load / URL hash | `src/store/persistence.ts` (`SCHEMA_VERSION`, `normalizePersisted`) |
| Quality presets | `src/utils/quality.ts` (`assertQualityInvariants`) |
| UI | Changed flow in the browser. Screenshot ≠ verification. |

`src/gpu/shader.ts` is the fixed part of the renderer (camera, shading, grid, gizmo). Do not open it unless the task needs it. Do not “clean up” it while doing something else.

## Data flow

```
sceneStore (CSG tree)
  → sceneCompiler.ts: structure → WGSL (ds_sdScene, ds_sceneInfo), numbers → Float32Array (bake.ts per shape)
  → useGpu.ts: code string → cached pipeline (initAsync, off the critical path); values → uniform buffer
  → shader.ts raymarches through two slots filled with the generated functions
  → persistence.ts writes hash + localStorage
  → generateSdfCode.ts exports the same tree as TypeGPU / WGSL / GLSL (same primitive sources)
```

Selection lives on the store (`selectedItemId`, `selectedContainerId`, `rootSelected`). Undo/redo (`undoScene` / `redoScene`) clears selection back to the scene root.

## Hard contracts

These are the things that silently black-screen, clip the CSG, or lose the user’s scene.

### 1. Shape registry

A shape is not registered until **all** of these know it, with the same key:

- `ShapeType` + `DEFAULT_PARAMS` + `TYPE_LABEL` in `sceneStore.ts`
- `TG_HELPERS` / `WGSL_HELPERS` / `GLSL_HELPERS` and `primitiveCall` in `src/sdf/primitives.ts` — one source per language, used by both the viewport (compiled scene) and the export. `primitiveCall`'s switch has no default, so `tsc` catches a missing arm.
- `shapeBoundRadius` in `src/gpu/bounds.ts` — a too-small radius makes culling cut the shape off.
- `SHAPE_ICONS` in `commands.ts` (`Record<ShapeType, …>` will fail typecheck if an icon is missing; toolbar `SHAPES` vs palette `EXTRA_SHAPES` is a separate product choice). Icons are generated: add the shape to `icons` in `scripts/gen-shape-icons.mjs`, run `node scripts/gen-shape-icons.mjs`
- `e2e/scenes.ts` `SHAPES` (render tests) and `src/test/fixtures.ts` `kitchenSink` (codegen snapshot + compile test).

### 2. Compiled scene

`compileScene(root)` (sceneCompiler.ts) returns `{ code, values, leafIds, markIndex }`.

- **Code is the cache key.** Equal code ⇔ equal value layout. Anything that changes slot allocation or emitted statements must be reflected in the code string, or a cached program reads the wrong slots. Structure (node kinds, shape types, ops, image presence, chunking) goes into code; numbers never do — a slider drag must not recompile.
- Values are vec4f slots in `dsData` (uniform, `DATA_SLOTS` = 4096 = 64 KiB). Leaf: 3 rows (+offset in `.w`), params, misc `(factor, smoothK, highlight, _)`, bound sphere, image extras. Group: misc, bound. Chunk: bound.
- GPU eval per leaf: `q = (row0·p, row1·p, row2·p) + offset`, `dist = sd(q, params) * factor`.
- Culling: union / sUnion siblings are gated by their bounding sphere against the running result (`bound < acc (+k)`); subtract / intersect children always evaluate. The head of a list may stand in its sphere beyond `CULL_DIST` only if every op up to the root is hard union. Long hard-union runs are split into list-order chunks (positions never change the code). A bound radius that is too small silently clips geometry — see `bounds.ts`.
- `ds_sceneInfo` (evaluated once per pixel at the hit) gives highlight glow and the pick id. Pick ids are 16-bit: low byte in R and B, high byte in G (`readPickIdFromBytes`).
- Generated helpers are prefixed `ds_` so they cannot collide with names TypeGPU generates.
- The program on screen keeps its own `CompiledScene`: values are uploaded only when they match the active program; pick ids resolve against the program that drew them.
- Frames are drawn only when an input changed (camera, size, values, program, gizmo mode, images). Anything new that changes the image must feed that signature in `frame()`.

Group/layer transforms are **not** a GPU stack. They are baked on the CPU (`bake.ts`) into `row0/1/2`, `offset`, `factor`.

Shape `image` samples a baked 2D SDF (`src/utils/imageSdf.ts`) from an `r16float` `texture_2d_array` (`IMAGE_SDF_RES`², `MAX_IMAGES` layers). The PNG stores 16 bits as coarse `.r` + residual `.g` (`IMAGE_SDF_STEP_PX`); `decodeSdfPng` reassembles to f16 for the app, exported code reassembles per tap. Texel→distance mapping and the outside-the-square bound `√(dBox² + dEdge²)` live in `sdImageField` (`src/sdf/primitives.ts`, shared by viewport and export) and `imageSdf.ts`; change one, change both. The layer's `params[3]` is the invert flag and the rounding radius lives in `image.round` (optional, default 0, ≤ `IMAGE_ROUND_MAX`); the compiler writes `(round, invert, layer, hasImage)` into the leaf's extra slot. Texture layers are assigned per distinct `image.sdf` string by `syncImageSlots` before every compile.

### 3. Bake math

`bake.ts` must reproduce the old GPU transform exactly. Image changes if the order changes.

```
pEval = T_{n-1}(…T_0(p))     T_k(x) = D(1/s_k) · R_k⁻¹ · (x − p_k)
lp    = D(1/acc) · R_shape⁻¹ · D(acc) · (pEval − shapePos)   // unsheared trick
q     = D(1/shapeScale) · lp
dist  = sd(q) · min(shapeScale) · min(acc)
```

`acc` = componentwise product of ancestor group scales. Rotation is Euler XYZ, inverted as `Rx(−x)·Ry(−y)·Rz(−z)` (`invRotXYZ`).

`assertBakeParity()` runs on import of `bake.ts`. Do not delete it. Do not “simplify” the matrices.

Scale below `MIN_SCALE` (0.01) is illegal — divide-by-zero in the bake.

### 4. Persistence

`SCHEMA_VERSION = 6` (v4/v5 still accepted: strict subsets; v6 adds optional `image.round`). Stored in `location.hash` (base64 JSON) and `localStorage` key `d-stance_scene`. Image layers embed their SDF PNG (`image.sdf`, ~15–40 KB each) in the hash; `normalizePersisted` drops image layers whose `sdf` fails `isImageSdfDataUrl`.

- Hash/LS is a **trust boundary**. Users and old links can send missing/hostile fields.
- New persisted field → bump `SCHEMA_VERSION` **and** teach `normalizePersisted` a default. Old blobs with the wrong `v` are dropped (`null`), not partially applied.
- Additive-only example already in tree: missing `scale` → `[1,1,1]`, then clamped with `Math.max(0.01, abs(n))`.
- Counters for shapes added after a save are filled via `{ ...zeroCounters(), ...saved.counters }`. Same idea if you add a counter.

Losing a scene is data loss. Treat persist mistakes like a security bug.

### 5. Caps

| Cap | Value | Meaning |
|---|---|---|
| `MAX_INSTRUCTIONS` | 256 | Scene size budget (`countInstructions`: shapes + ops) |
| `MAX_TRANSFORM_DEPTH` | 16 | Nested group depth |
| `DATA_SLOTS` | 4096 | vec4f value slots (64 KiB uniform); `countDataSlots` stays far below it inside `MAX_INSTRUCTIONS` |
| `MAX_IMAGES` | 8 | Distinct image SDFs per scene (texture array layers) |

UI toasts exist for cap / cycle / depth. Do not raise a cap in one file and leave the others.

## TypeGPU

`typegpu@0.12` + `unplugin-typegpu@0.12` (Vite). Official skill lives at `.agents/skills/typegpu` and **targets 0.12**. Use the named export: `import { tgpu, d, std } from "typegpu"`.

Operator overloads inside `"use gpu"` are understood by **tsover** (this repo’s `typescript` package). If the editor shows `+` / `*` errors on `d.v3f`, it is using bundled TypeScript — switch to the workspace version. Do not “fix” those errors by rewriting operators into `std.add` unless asked.

Lookup order for TypeGPU / `"use gpu"` code:

1. `.agents/skills/typegpu/SKILL.md` — then the reference file it names for the task (`references/types.md`, `shaders.md`, `std.md`, …).
2. https://docs.swmansion.com/TypeGPU/ — only if the skill does not cover the question.
3. Never guess.

Do not copy API essays from the skill into this file.

Pitfalls:

- No `mat2f` / `m22f` → `d.mat2x2f` / `d.m2x2f`
- No swizzle assignment (`v.xz = …`) → rebuild the vector
- GPU-side uniform/buffer read is `.$` (not `.value`)
- `"use gpu"` must be the first statement in the function body
- `Math.*` is not the GPU stdlib — use `std.*`

## Do not

- Guess TypeGPU APIs or WGSL alignment.
- Put a per-scene number into generated code (recompiles on every drag) or change slot layout without changing the code string.
- Raise or bypass caps without updating the compiler budget test, UI toasts, and this file.
- Bump or skip `SCHEMA_VERSION` “just in case”.
- Refactor `shader.ts` as a drive-by.
- Delete `assertBakeParity` / `assertQualityInvariants`.
- Add a dependency or abstraction that was not asked for.

## After a change

1. `npx tsc -b` (same check as `npm run build`).
2. `npm test` (Vitest unit tests, `src/**/*.test.ts`). If you touched bake / quality / persist / scene compiler / shape registry: keep the import-time asserts (`assertBakeParity`, `assertQualityInvariants`) and add a test next to the module. Kitchen-sink fixtures live in `src/test/fixtures.ts`; codegen output is snapshot-tested (update snapshots only for intended output changes: `npx vitest run -u`).
3. GPU files (`shader.ts`, `sceneCompiler.ts`, `bake.ts`, `useGpu.ts`): `npm run inspect:gpu`, then the e2e suite — it compiles real generated programs. `tsc` does not compile WGSL. MCP tool: `typegpu_inspector` → `inspect_typegpu` on `src/gpu/shader.inspect.ts` (compiles a kitchen-sink scene). Perf: `PW_TOOLS=1 npx playwright test tools/bench`; render parity vs a baseline branch: `tools/golden` + `tools/parity`.
4. `npm run test:e2e` (Playwright, `e2e/`). Headless Chromium runs real WebGPU (Metal on macOS); helpers in `e2e/helpers.ts` load a scene through the hash, wait for `canvas[data-ready]`, and measure canvas pixels with the UI hidden. Exported WGSL/GLSL is compiled by the browser in `e2e/export.spec.ts`. Dev builds expose `window.__dstance` (store + scene) for tests.
5. UI: exercise the changed flow in the browser (click/type/drag). Check the other surfaces that read the same store (tree, inspector, gizmo, code export, hash after reload).
6. New persist field: load an old `v: 4` blob and a blob missing the field.
7. Image import: `src/utils/imageSdf.ts` runs `assertImageSdf()` on import (EDT + u8 round trip). Exercise paste/drop → dialog → add, then reload from hash.

Code, commits, and PR text stay normal prose. Do not commit unless asked.
