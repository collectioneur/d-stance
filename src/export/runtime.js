// d-stance embed runtime — draws an exported SDF scene into a <canvas>.
// WebGPU when available, WebGL2 otherwise. No dependencies.
//
//   const stop = mount(canvas, scene, { autoRotate: 0.3 });
//   stop(); // detach listeners, free the GPU
//
// scene = { wgsl, glsl, images: [pngDataUrl],
//           view: { rotX, rotY, distance, target: [x, y, z], fit?: radius },
//           loop?: seconds, interact?: { parent, hoverable, clickable, pointer } }
// With `fit`, the distance adapts to the canvas so a sphere of that radius
// around `target` stays in frame (until the user zooms). `loop`: the scene
// animates, its clock wraps. `interact`: items react to hover / click (a
// one-pixel GPU pick finds the item under the cursor) or follow the pointer.
// options: orbit (drag to rotate), zoom (ctrl/⌘ + wheel or pinch, so page
// scrolling is never hijacked), autoRotate (rad/s), animate, maxDpr, backend
// ("auto" | "webgpu" | "webgl2"). Draws only when something changed and
// never while the canvas is off screen.

const GL_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

async function loadBitmap(url) {
  const blob = await (await fetch(url)).blob();
  // Raw bytes: the PNG encodes distances, not colors.
  return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
}

/** View uniform: res, rot, dist, time, pointer, center, pick (WGSL `View`, 64 bytes). */
function viewFloats(out, canvas, view, pointer, pick) {
  out.set([canvas.width, canvas.height, view.rotX, view.rotY, view.distance, view.time, pointer[0], pointer[1], ...view.target, 0, pick[0], pick[1], 0, 0]);
  return out;
}

async function createWebGpu(canvas, scene, ixCount) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  // One layout for the draw and the pick pipeline.
  const F = GPUShaderStage.FRAGMENT;
  const layoutEntries = [{ binding: 100, visibility: F, buffer: { type: "uniform" } }];
  if (ixCount > 0) layoutEntries.push({ binding: 101, visibility: F, buffer: { type: "uniform" } });
  if (scene.images.length > 0) {
    layoutEntries.push({ binding: 0, visibility: F, sampler: { type: "filtering" } });
    scene.images.forEach((_, i) => layoutEntries.push({ binding: i + 1, visibility: F, texture: { sampleType: "float" } }));
  }
  const bindGroupLayout = device.createBindGroupLayout({ entries: layoutEntries });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  // Compile before touching the canvas: a canvas keeps the first context
  // type it hands out, and WebGL2 must stay possible if this fails.
  const module = device.createShaderModule({ code: scene.wgsl });
  const pipeline = await device.createRenderPipelineAsync({
    layout,
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
  });
  const pickPipeline =
    ixCount > 0
      ? await device.createRenderPipelineAsync({
          layout,
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs_pick", targets: [{ format: "rgba8unorm" }] },
        })
      : null;
  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    return null;
  }
  context.configure({ device, format, alphaMode: "premultiplied" });
  const viewBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const entries = [{ binding: 100, resource: { buffer: viewBuffer } }];
  const ixBuffer =
    ixCount > 0 ? device.createBuffer({ size: ixCount * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) : null;
  if (ixBuffer) entries.push({ binding: 101, resource: { buffer: ixBuffer } });
  const textures = [];
  if (scene.images.length > 0) {
    entries.push({
      binding: 0,
      resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
    });
    for (const [i, url] of scene.images.entries()) {
      const bitmap = await loadBitmap(url);
      const texture = device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
      textures.push(texture);
      entries.push({ binding: i + 1, resource: texture.createView() });
    }
  }
  const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries });
  const viewData = new Float32Array(16);
  const pickTarget = pickPipeline
    ? device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    : null;
  const pickRead = pickPipeline ? device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;

  const upload = (view, state, pick) => {
    device.queue.writeBuffer(viewBuffer, 0, viewFloats(viewData, canvas, view, state.pointer, pick));
    if (ixBuffer) device.queue.writeBuffer(ixBuffer, 0, state.ix);
  };
  const pass = (encoder, target, pipe) => {
    const p = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
    });
    p.setPipeline(pipe);
    p.setBindGroup(0, bindGroup);
    p.draw(3);
    p.end();
  };

  return {
    draw(view, state) {
      upload(view, state, [0, 0]);
      const encoder = device.createCommandEncoder();
      pass(encoder, context.getCurrentTexture().createView(), pipeline);
      device.queue.submit([encoder.finish()]);
    },
    /** Pick id (0 = nothing) of the interactive item at canvas pixel px. */
    async pick(view, state, px) {
      if (!pickPipeline) return 0;
      upload(view, state, px);
      const encoder = device.createCommandEncoder();
      pass(encoder, pickTarget.createView(), pickPipeline);
      encoder.copyTextureToBuffer({ texture: pickTarget }, { buffer: pickRead, bytesPerRow: 256 }, [1, 1]);
      device.queue.submit([encoder.finish()]);
      await pickRead.mapAsync(GPUMapMode.READ);
      const id = new Uint8Array(pickRead.getMappedRange(0, 4))[0];
      pickRead.unmap();
      return id;
    },
    destroy() {
      textures.forEach((t) => t.destroy());
      device.destroy();
    },
  };
}

async function createWebGl(canvas, scene, ixCount) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, GL_VERTEX);
  const link = (fragment) => {
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
    }
    const loc = (name) => gl.getUniformLocation(program, name);
    return {
      program,
      uRes: loc("uRes"),
      uRot: loc("uRot"),
      uDist: loc("uDist"),
      uTime: loc("uTime"),
      uTarget: loc("uTarget"),
      uPointer: loc("uPointer"),
      uPick: loc("uPick"),
      uIx: loc("uIx"),
      images: scene.images.map((_, i) => loc(`imageTex${i}`)),
    };
  };
  const main = link(scene.glsl);
  // The pick variant: same source with PICK defined (right after #version).
  const pickProgram = ixCount > 0 ? link(scene.glsl.replace(/^(#version[^\n]*\n)/, "$1#define PICK 1\n")) : null;

  const textures = [];
  for (const [i, url] of scene.images.entries()) {
    const bitmap = await loadBitmap(url);
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures.push(texture);
  }
  for (const p of [main, pickProgram]) {
    if (!p) continue;
    gl.useProgram(p.program);
    p.images.forEach((l, i) => gl.uniform1i(l, i));
  }

  let pickFbo = null;
  let pickTex = null;
  if (pickProgram) {
    pickTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + scene.images.length);
    gl.bindTexture(gl.TEXTURE_2D, pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  const pixel = new Uint8Array(4);

  const use = (p, view, state, pick) => {
    gl.useProgram(p.program);
    gl.uniform2f(p.uRes, canvas.width, canvas.height);
    gl.uniform2f(p.uRot, view.rotX, view.rotY);
    gl.uniform1f(p.uDist, view.distance);
    gl.uniform1f(p.uTime, view.time);
    gl.uniform3f(p.uTarget, ...view.target);
    if (p.uPointer) gl.uniform2f(p.uPointer, state.pointer[0], state.pointer[1]);
    if (p.uPick) gl.uniform2f(p.uPick, pick[0], pick[1]);
    if (p.uIx) gl.uniform4fv(p.uIx, state.ix);
  };

  return {
    draw(view, state) {
      use(main, view, state, [0, 0]);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    async pick(view, state, px) {
      if (!pickProgram) return 0;
      use(pickProgram, view, state, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
      gl.viewport(0, 0, 1, 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return pixel[0];
    },
    destroy() {
      textures.forEach((t) => gl.deleteTexture(t));
      if (pickTex) gl.deleteTexture(pickTex);
      if (pickFbo) gl.deleteFramebuffer(pickFbo);
      gl.deleteProgram(main.program);
      if (pickProgram) gl.deleteProgram(pickProgram.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

export function mount(canvas, scene, options = {}) {
  const opts = { orbit: true, zoom: true, autoRotate: 0, animate: true, maxDpr: 2, backend: "auto", ...options };
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) {
    opts.autoRotate = 0;
    opts.animate = false;
  }
  // Animated scenes loop their clock like the editor's timeline.
  const loop = opts.animate && scene.loop > 0 ? scene.loop : 0;
  const view = {
    rotX: scene.view.rotX,
    rotY: scene.view.rotY,
    distance: scene.view.distance,
    target: scene.view.target ?? [0, 0, 0],
    time: 0,
  };
  let fit = scene.view.fit ?? 0;
  let renderer = null;
  let dirty = true;
  let visible = true;
  let destroyed = false;
  let raf = 0;
  let last = performance.now();
  const start = last;

  // ── Reactions: per-item hover / click (eased 0..1) and the pointer (−1..1) ──
  const interact = scene.interact ?? null;
  const ixCount = interact ? interact.parent.length : 0;
  const state = { ix: new Float32Array(Math.max(1, ixCount) * 4), pointer: [0, 0] };
  const hoverTo = new Float32Array(ixCount);
  const clickTo = new Float32Array(ixCount);
  const pointerTo = [0, 0];
  let settled = true;
  /** Pick id → that item and its interactive ancestors (slots, innermost first). */
  const chain = (id) => {
    const out = [];
    for (let s = id - 1; s >= 0 && out.length <= ixCount; s = interact.parent[s]) out.push(s);
    return out;
  };
  const ease = (value, to, dt) => {
    // ≈ 90% of the way in 0.2 s; instant under reduced motion.
    const next = reducedMotion ? to : value + (to - value) * Math.min(1, dt * 12);
    return Math.abs(to - next) < 0.002 ? to : next;
  };
  const stepStates = (dt) => {
    settled = true;
    for (let i = 0; i < ixCount; i++) {
      state.ix[i * 4] = ease(state.ix[i * 4], hoverTo[i], dt);
      state.ix[i * 4 + 1] = ease(state.ix[i * 4 + 1], clickTo[i], dt);
      if (state.ix[i * 4] !== hoverTo[i] || state.ix[i * 4 + 1] !== clickTo[i]) settled = false;
    }
    for (let a = 0; a < 2; a++) {
      state.pointer[a] = ease(state.pointer[a], pointerTo[a], dt);
      if (state.pointer[a] !== pointerTo[a]) settled = false;
    }
  };

  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, opts.maxDpr);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      dirty = true;
    }
    if (fit) {
      // Vertical half-FOV is 45°; narrow canvases are limited by width.
      const halfFov = Math.atan(Math.min(1, w / h));
      view.distance = (fit * 1.1) / Math.sin(halfFov);
    }
  };

  const frame = (now) => {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (opts.autoRotate && !dragging) {
      view.rotX += opts.autoRotate * dt;
      dirty = true;
    }
    if (loop) {
      view.time = ((now - start) / 1000) % loop;
      dirty = true;
    }
    if (!settled) {
      stepStates(dt);
      dirty = true;
    }
    if (dirty && visible && renderer) {
      resize();
      renderer.draw(view, state);
      dirty = false;
    }
    if (opts.autoRotate || loop || !settled || dirty) schedule();
  };
  const schedule = () => {
    if (!raf && !destroyed && visible) raf = requestAnimationFrame(frame);
  };
  const invalidate = () => {
    dirty = true;
    schedule();
  };
  const react = () => {
    settled = false;
    schedule();
  };

  // ── Picking: one in flight, the latest request wins ──
  let pickWant = null;
  let picking = false;
  let hovered = 0;
  const toPixel = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  const pickAt = async (px) => {
    if (!renderer || !visible) return null;
    while (picking) await new Promise((r) => requestAnimationFrame(r));
    if (destroyed) return null;
    picking = true;
    try {
      return await renderer.pick(view, state, px);
    } finally {
      picking = false;
    }
  };
  const setHovered = (id) => {
    if (id === hovered) return;
    hovered = id;
    canvas.dataset.hovered = String(id);
    hoverTo.fill(0);
    let clickable = false;
    for (const s of id > 0 ? chain(id) : []) {
      if (interact.hoverable[s]) hoverTo[s] = 1;
      if (interact.clickable[s]) clickable = true;
    }
    canvas.style.cursor = clickable ? "pointer" : opts.orbit ? "grab" : "";
    react();
  };
  const drainHover = async () => {
    while (pickWant && !dragging) {
      const px = pickWant;
      pickWant = null;
      const id = await pickAt(px);
      if (id !== null && !pickWant && !dragging) setHovered(id);
    }
  };

  // ── Interaction ──
  let dragging = null;
  let press = null;
  const onDown = (e) => {
    if (e.button !== 0) return;
    press = { x: e.clientX, y: e.clientY, at: performance.now() };
    if (!opts.orbit) return;
    dragging = { x: e.clientX, y: e.clientY, rotX: view.rotX, rotY: view.rotY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (dragging) {
      if (!dragging.moved && Math.hypot(e.clientX - dragging.x, e.clientY - dragging.y) < 4) return;
      if (!dragging.moved) {
        dragging.moved = true;
        canvas.style.cursor = "grabbing";
        if (ixCount) setHovered(0);
      }
      view.rotX = dragging.rotX + ((e.clientX - dragging.x) / canvas.clientWidth) * Math.PI * 2;
      view.rotY = dragging.rotY + ((e.clientY - dragging.y) / canvas.clientHeight) * Math.PI * 2;
      invalidate();
      return;
    }
    if (ixCount && e.pointerType !== "touch") {
      pickWant = toPixel(e);
      void drainHover();
    }
  };
  const onUp = async (e) => {
    const wasDrag = dragging?.moved;
    dragging = null;
    canvas.style.cursor = opts.orbit ? "grab" : "";
    const p = press;
    press = null;
    if (!ixCount || wasDrag || !p || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 4) return;
    // A tap or click: toggle every clickable item in the chain under it.
    const id = await pickAt(toPixel(e));
    if (!id) return;
    for (const s of chain(id)) if (interact.clickable[s]) clickTo[s] = clickTo[s] > 0.5 ? 0 : 1;
    if (e.pointerType === "mouse") {
      // Keep the hover cursor in sync after the click.
      hovered = -1;
      setHovered(id);
    }
    react();
  };
  const onLeave = () => {
    pickWant = null;
    if (ixCount) setHovered(0);
  };
  // Pointer reactions follow the cursor anywhere on the page.
  const onPagePointer = (e) => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    pointerTo[0] = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    pointerTo[1] = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    react();
  };
  const onPageLeave = (e) => {
    if (e.relatedTarget) return;
    pointerTo[0] = 0;
    pointerTo[1] = 0;
    react();
  };
  // Plain wheel scrolls the page; ctrl/⌘ + wheel (and trackpad pinch) zooms.
  const onWheel = (e) => {
    if (!opts.zoom || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    fit = 0; // the user framed it now
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    view.distance = Math.min(20, Math.max(0.5, view.distance * Math.exp(px * 0.002)));
    invalidate();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  const followPointer = !!interact?.pointer;
  if (followPointer) {
    window.addEventListener("pointermove", onPagePointer, { passive: true });
    document.addEventListener("pointerout", onPageLeave);
  }
  if (opts.orbit) {
    canvas.style.cursor = "grab";
    canvas.style.touchAction = "pan-y"; // vertical swipes still scroll the page
  }

  const resizeObserver = new ResizeObserver(invalidate);
  resizeObserver.observe(canvas);
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) invalidate();
  });
  visibility.observe(canvas);

  const tryBackend = async (name) => {
    try {
      return name === "webgpu" ? await createWebGpu(canvas, scene, ixCount) : await createWebGl(canvas, scene, ixCount);
    } catch (err) {
      console.warn(`d-stance: ${name} failed`, err);
      return null;
    }
  };
  (async () => {
    const order =
      opts.backend === "webgl2" ? ["webgl2"] : opts.backend === "webgpu" ? ["webgpu"] : ["webgpu", "webgl2"];
    for (const name of order) {
      if (name === "webgpu" && !navigator.gpu) continue;
      renderer = await tryBackend(name);
      if (renderer) canvas.dataset.backend = name;
      if (renderer || destroyed) break;
    }
    if (destroyed) renderer?.destroy();
    else if (renderer) invalidate();
    else console.warn("d-stance: neither WebGPU nor WebGL2 is available");
  })();

  return function destroy() {
    destroyed = true;
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    visibility.disconnect();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("wheel", onWheel);
    if (followPointer) {
      window.removeEventListener("pointermove", onPagePointer);
      document.removeEventListener("pointerout", onPageLeave);
    }
    renderer?.destroy();
  };
}
