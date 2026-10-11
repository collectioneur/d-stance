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
| Embed / Shadertoy export | `src/export/` (`embed.ts`, `renderTemplates.ts`, `runtime.js`) |
| Modifiers (repeat, mirror, polar, twist, bend, elongate, round, onion) | `src/store/modifiers.ts`, `src/sdf/modifierMath.ts` (planner), `src/sdf/itemBounds.ts`, compiler frames, `MODIFIER_*` in `src/sdf/primitives.ts`, codegen `withMods` |
| Materials / render modes | `src/store/material.ts`, compiler `MAT` slots + `combineStmt`, `shader.ts` (`shadeClassic` / `shadeStudio` / chrome), `src/export/renderTemplates.ts`, `generateMaterialCode` |
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
  → src/export/embed.ts wraps that SDF in the viewport's camera + shading (renderTemplates.ts)
    and inlines runtime.js → HTML snippet / JS module / standalone page / Shadertoy
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
- `RightPanel.tsx` `SIZE_FIELDS` (inspector fields per param).

Three shapes are special: `image` (texture sampling, per-language wrappers), `formula` (no static source — `src/sdf/formula.ts` parses the user's `formula` string and emits one function per distinct source in every language) and `stroke` (sculpted polylines, see 2h). All are excluded from `primitiveCall`. Terrain samples `terrainHeight` from the shared noise sources (`NOISE_*` in primitives.ts, emitted before shapes because GLSL needs declaration order).

### 2. Compiled scene

`compileScene(root)` (sceneCompiler.ts) returns `{ code, values, leafIds, markIndex }`.

- **Code is the cache key.** Equal code ⇔ equal value layout. Anything that changes slot allocation or emitted statements must be reflected in the code string, or a cached program reads the wrong slots. Structure (node kinds, shape types, ops, image presence, chunking) goes into code; numbers never do — a slider drag must not recompile.
- Values are vec4f slots in `dsData` (uniform, `DATA_SLOTS` = 4096 = 64 KiB). Leaf: 3 rows (+offset in `.w`), params, misc `(factor, smoothK, highlight, _)`, bound sphere, image extras. Group: misc, bound. Chunk: bound.
- GPU eval per leaf: `q = (row0·p, row1·p, row2·p) + offset`, `dist = sd(q, params) * factor`.
- Culling: union / sUnion siblings are gated by their bounding sphere against the running result (`bound < acc (+k)`); subtract / intersect children always evaluate. The head of a list may stand in its sphere beyond `CULL_DIST` only if every op up to the root is hard union. Long hard-union runs are split into list-order chunks (positions never change the code). A bound radius that is too small silently clips geometry — see `bounds.ts`.
- `ds_sceneInfo` (evaluated once per pixel at the hit) gives highlight glow, the pick id and the blended material (`DsInfo` → TypeGPU `SceneInfo`). Pick ids are 16-bit: low byte in R and B, high byte in G (`readPickIdFromBytes`).
- Generated helpers are prefixed `ds_` so they cannot collide with names TypeGPU generates.
- The program on screen keeps its own `CompiledScene`: values are uploaded only when they match the active program; pick ids resolve against the program that drew them.
- Frames are drawn only when an input changed (camera, size, values, program, gizmo mode, images). Anything new that changes the image must feed that signature in `frame()`.

Group/layer transforms are **not** a GPU stack. They are baked on the CPU (`bake.ts`) into `row0/1/2`, `offset`, `factor`.

Shape `image` samples a baked 2D SDF (`src/utils/imageSdf.ts`) from an `r16float` `texture_2d_array` (`IMAGE_SDF_RES`², `MAX_IMAGES` layers). The PNG stores 16 bits as coarse `.r` + residual `.g` (`IMAGE_SDF_STEP_PX`); `decodeSdfPng` reassembles to f16 for the app, exported code reassembles per tap. Texel→distance mapping and the outside-the-square bound `√(dBox² + dEdge²)` live in `sdImageField` (`src/sdf/primitives.ts`, shared by viewport and export) and `imageSdf.ts`; change one, change both. The layer's `params[3]` is the invert flag and the rounding radius lives in `image.round` (optional, default 0, ≤ `IMAGE_ROUND_MAX`); the compiler writes `(round, invert, layer, hasImage)` into the leaf's extra slot. Texture layers are assigned per distinct `image.sdf` string by `syncImageSlots` before every compile.

### 2g. Text

Text layers are image layers (`shapeType: "image"`) whose `image.text` (`src/utils/textSdf.ts`) records what they were baked from: words, font, weight, italic, spacing, align. `bakeTextSdf` lays the lines out by their ink inside the padded square at `MASK_SDF_SIZE` and goes through `encodeMaskSdf` (the same EDT + PNG as image import), so GPU, export, Shadertoy dropping and the `MAX_IMAGES` cap treat text exactly like an image. The baked `image.sdf` stays the source of truth (persisted; other machines may lack a font); `image.text` is only for re-editing. Fonts: Inter / JetBrains Mono ship with the app; custom families are whitelisted by `customFamily`.

### 2h. Sculpt strokes

- `stroke` layers hold `stroke.points` (x, y, z, radius per point, layer-local; radius ≤ 0 is a break, placed on the next line's start). The SDF is a union of tapered capsules, evaluated per `STROKE_CHUNK` segments behind chunk bounding spheres (`src/sdf/stroke.ts`: `packStroke` = chunk spheres then points). CPU reference: `strokeDistance`; next to a break a segment is a sphere on its live end — every implementation (CPU, `ds_strokeSeg`, `STROKE_HELPERS`) must agree.
- Editor: the compiler appends each stroke's packed data to `CompiledScene.strokes` (read-only storage `dsStroke`, `MAX_STROKE_DATA` vec4s, checked by `validateRoot`) and writes `(chunk base, chunks, point base, points)` into the leaf's extra slot. Offsets are **data**: painting never recompiles. Strokes get a `limit` (union: acc + k, subtract: k − acc) and stop searching past it — exact for those ops, ~3× faster on heavy sculpts. Exports pass the same bound (`combineLimit`) and embed the points as constant arrays.
- Sculpt tool (`src/scene/sculpt.ts`, `useBrushStore`): a stroke on a shape wraps it into an object (group) with the shape's position/rotation; strokes append to the last stroke layer while the brush mode and mirror match. The in-progress line is a preview layer (`PREVIEW_STROKE_ID`) that the depth pick skips (`SceneUniforms.skipLeaf`, compared per stroke leaf) so a stroke never stacks on itself; the end merges it (`finishLine`: RDP, taper, rounding) as one undo step. Depth comes from `PICK_PASS_DEPTH` (24 bit, `PICK_DEPTH_RANGE`) plus the CPU camera ray (`computeCameraRayFromClient`).
- Strokes run one after another (`strokeChain`); sculpt store updates are "quiet" for the spawn animation, and the spawn animation never animates a restructure (a new group holding existing items, or the reverse).

### 2a. Materials and render modes

- `Material` (`src/store/material.ts`): sRGB `color`, `roughness`, `metalness`, `emission`. Optional on shapes and groups; a shape without one uses the nearest ancestor group's, then `DEFAULT_MATERIAL` (0.72 gray — the editor's original look; Classic/Chrome with the default must stay pixel-identical to before materials). Persisted since schema v7, sanitized by `sanitizeMaterial`.
- Materials are values (leaf slots `MAT`, `MAT+1`), never code. They travel through the CSG only in the info pass: union/intersect take the winner, smooth ops blend with the smooth-min weight, subtract keeps the body's material. The export's `generateMaterialCode` must follow the same rules.
- Render mode is a pipeline slot (`renderModeSlot`), not a uniform: each mode is its own cached program, so unused modes cost nothing. Programs are keyed by `mode + code`.
- Fetch the scene info / material **after** march loops (shadow, AO, reflection). Holding it across a loop that inlines the scene SDF cost 2–4× frame time in crowded scenes.
- **One scene-SDF call site per loop.** Every call inlines the whole generated scene; a second call inside a march loop (Volume's light probe) made crowded scenes ~8× slower. Alternate what one call evaluates instead (`renderVolume`'s `probing`), and fetch materials after the loop.
- Modes: Looks `classic`, `chrome`, `studio`, `neon`, `volume` (all exportable: `renderTemplates.ts` mirrors them, emitting only the chosen style's code; `VOLUME_EDGE` / `VOLUME_STEP` and the volume noise are shared numbers) and Inspect `field` (distance isolines on the slice `SceneUniforms.sliceY`, was `_pad2`), `cost` (steps heatmap), `normals` — editor only; the embed falls back to Classic. Unknown stored modes fall back to Classic (`renderStore` merge). Picking always uses the surface march, whatever the mode.

### 2c. Modifiers

- `Modifier[]` on shapes and groups (schema v8, `sanitizeModifiers`). Point modifiers rewrite the evaluation point in list order; distance modifiers (round, onion) rewrite the result. On a group they act in the group's frame (after its transform); on a shape in its local, scaled frame.
- **One planner:** `planPointModifiers` (via `shapePlan` / `groupPlan` in `itemBounds.ts`) decides neighbor-cell loops for overlapping repeats and the 1/Lipschitz factor of twist / bend. The viewport compiler and the export both call it — never re-derive these decisions elsewhere, or the export stops matching the viewport.
- In the compiler, a group with point modifiers opens a **frame**: its local point is computed in code (3 affine slots), modifiers run on it, children bake relative to it, and their bound gates are scaled by the frame's distance scale (`misc.w`). Bounds are grown through the modifiers (`expandThrough`, reversed order); infinite repetition is `UNBOUNDED` and the march radius is capped at `MAX_SCENE_RADIUS`.
- Numbers (spacing, counts, amounts) are values; kinds, axes, mirror axes, neighbor loops and on/off are code.
- WGSL / GLSL / TypeGPU helper sources live in `primitives.ts` (`MODIFIER_*`); the compiler prefixes them `ds_`. Export helper names are reserved (`RESERVED` in generateSdfCode).

### 2d. Noise and formulas

- Noise uses **integer hashing only** (`NOISE_WGSL` / `NOISE_GLSL`) so WebGPU, WebGL2 and every driver produce the same field. Never switch to sin-based float hashes.
- The noise modifier samples the item's own point *before* its point modifiers, so repeated copies differ. Its 1/Lipschitz (`postInvLipschitz`) and reach (`noiseReach`) feed the shared plans — changing the noise sum changes both.
- Formulas are a trust boundary (hash links): `parseFormula` is a closed recursive-descent parser with a function / constant whitelist looked up by **own** keys only (`constructor` is not a function). `sanitizeFormula` replaces anything that does not parse. Never emit user text that did not come out of the AST emitter.

### 2e. Animation

- Tracks (`src/store/animation.ts`): `value = base + amount · wave(t / period + phase)`; scale multiplies (`base · (1 + …)`, clamped at `MIN_SCALE`). The editor evaluates them **on the CPU** each frame (`evaluateAnimations` in `useGpu.ts`), so playback rewrites uniforms and never recompiles. Items being dragged with the gizmo stay at rest (`still`).
- The clock reaches shaders only for things the CPU cannot fold: formula `t` and noise flow (`speed`). Compiler: `dsScene.time` (`SceneUniforms.time`, was `_pad1`).
- Export writes the same formula into code (`animationExpr`; `fmtEx` in generateSdfCode). An animated scene's SDF and material functions take a second parameter, `time`; still scenes keep the one-argument signature byte-for-byte. `waveAt` (CPU) and `waveExpr` (shader) must agree — `animation.test.ts` runs the GLSL expression in JS against the CPU for every waveform. `animHash` is bit-identical to the shader hash.
- Embeds loop the clock over the editor's loop length (`scene.loop`, `mod(iTime, loop)` on Shadertoy); the runtime redraws every frame only when the scene is animated, and holds the first pose under `prefers-reduced-motion`. Export bounds / floor / framing are sampled over the loop (`sceneExtent` in embed.ts).

### 2f. Interaction

- Reactions (`src/store/interaction.ts`): `value = base + amount · state`, same targets and units as tracks. Hover / click states are per item (eased 0..1); pointer X / Y are −1..1 over the canvas. Items with hover / click reactions get **slots** (`interactiveSlots`, tree order, capped at `MAX_INTERACTIVE`); a hovered shape activates its nearest interactive ancestor-or-self and every interactive ancestor above it (`slotChain`).
- Editor: "Try" mode (`tryStore`) feeds the same offsets through `evaluateAnimations(…, extra)` on the CPU; selection, hover glow and the gizmo rest while trying.
- Embed: `generateSdfCode(…, { interactive })` turns reactions into terms of `ix[slot]` / `view.pointer` (GLSL `uIx` / `uPointer`); without the option (code tab, Shadertoy) reactions sit at rest. The material gets an `id` (slot + 1 of the owner) so `fs_pick` / GLSL `PICK` can report the hovered item; pick ids fit one byte. Code-tab output for scenes without the option is unchanged.
- Moving values (time / states) are hoisted once per function (`let aN`); they never depend on `p`.

### 2b. Embed export

- `renderTemplates.ts` mirrors the viewport math in `shader.ts` (camera orbit order, march epsilons, classic/chrome shading, background). Change shading in one, change the other; `e2e/embed.spec.ts` compares the embed against the editor and WebGPU against WebGL2.
- `runtime.js` is plain JS on purpose: its source is inlined verbatim into every export (`?raw`). No imports, no TypeScript. Its types live in `runtime.d.ts`.
- The WebGPU view uniform is 64 bytes (`res, rot, dist, time, pointer, center, pick, jitter`) at `@group(0) @binding(100)`; `runtime.js` `viewFloats` writes it. Interaction states (`ix: array<vec4f, N>`) sit at `binding(101)`; generated image bindings own `binding(0)` (sampler) and `binding(1..N)`. The runtime builds one explicit bind group layout for the draw and pick pipelines. Avoid WGSL reserved words in templates (`target` is one).
- The runtime compiles the WebGPU pipeline before calling `getContext("webgpu")`: a canvas keeps its first context type, and WebGL2 must stay possible as the fallback.
- Inline JSON goes through `scriptJson` (escapes `<`). Scene names are user data.

### 2i. Progressive anti-aliasing

- Editor and embed both average jittered samples while the view holds still: sample 0 is the pixel center, sample i is offset by Halton(2, 3) − ½ px (`sampleOffset` in runtime.js, `halton` in useGpu.ts — same sequence, so editor and embed match). Samples blend into an `rgba16float` texture with blend constant `1 / (i + 1)` and are blitted to the canvas. **Set the blend constant in every pass** — it starts at 0 and silently drops the sample.
- Any change restarts at sample 0, so editing costs one sample per frame (plus a blit). Counts: `aaSamples` per quality preset (`assertQualityInvariants`), embed `aa` mount option (fast 4, balanced 16, best 32). Picks always aim at pixel centers (jitter is reset after the last sample).
- Tests: `__dstance.gpu.settled()` / embed `canvas[data-settled]` mean the image is final; `canvasShot` waits for it.

### 2j. Examples

- `src/scene/examples.ts` builds each example in code (stays valid as the schema grows); loading is one undoable store change plus a render mode and a camera glide (`requestView`). Thumbnails are generated with the export renderer: `PW_TOOLS=1 npx playwright test tools/example-thumbs` writes `src/assets/examples/*.jpg`.

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

`SCHEMA_VERSION = 13` (v4–v12 still accepted: strict subsets; v6 added optional `image.round`, v7 optional `material`, v8 optional `modifiers`, v9 terrain / gyroid / formula shapes and the noise modifier, v10 optional `animation` tracks and noise `speed`, v11 optional `interaction` reactions, v12 optional `image.text`, v13 the `stroke` shape). Stored in `location.hash` (base64 JSON) and `localStorage` key `d-stance_scene`. Image layers embed their SDF PNG (`image.sdf`, ~15–40 KB each) in the hash; `normalizePersisted` drops image layers whose `sdf` fails `isImageSdfDataUrl`.

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
| `MAX_TRACKS` / `MAX_REACTIONS` | 8 / 8 | Animation tracks / interaction reactions per item |
| `MAX_INTERACTIVE` | 64 | Items with hover / click states per embed (pick id is one byte) |
| `MAX_STROKE_POINTS` / `MAX_STROKE_DATA` | 1024 / 16384 | Points per stroke layer / vec4s of all strokes (points + chunk spheres) |

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
