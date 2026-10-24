// d-stance embed runtime — draws an exported SDF scene into a <canvas>.
// WebGPU when available, WebGL2 otherwise. No dependencies.
//
//   const stop = mount(canvas, scene, { autoRotate: 0.3 });
//   stop(); // detach listeners, free the GPU
//
// scene = { wgsl, glsl, images: [pngDataUrl],
//           view: { rotX, rotY, distance, target: [x, y, z], fit?: radius, zoom? } }
// With `fit`, the distance adapts to the canvas so a sphere of that radius
// around `target` stays in frame; `zoom` (and the user's zoom) multiplies it.
// options: orbit (drag to rotate), zoom (pinch, ctrl/⌘ + wheel), wheel
// ("auto": a plain wheel zooms only where it would not scroll anything, or
// after a click on the scene; "always"; "modifier"), autoRotate (rad/s),
// maxDpr, backend ("auto" | "webgpu" | "webgl2"), onView (called with
// { rotX, rotY, distance, zoom } when the user leaves the camera somewhere).
// Draws only when something changed and never while the canvas is off screen.

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

async function createWebGpu(canvas, scene) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  // Compile before touching the canvas: a canvas keeps the first context
  // type it hands out, and WebGL2 must stay possible if this fails.
  const module = device.createShaderModule({ code: scene.wgsl });
  const pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
  });
  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    return null;
  }
  context.configure({ device, format, alphaMode: "premultiplied" });
  const viewBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const entries = [{ binding: 100, resource: { buffer: viewBuffer } }];
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
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  const viewData = new Float32Array(12);

  return {
    draw(view) {
      viewData.set([canvas.width, canvas.height, view.rotX, view.rotY, view.distance, view.time, 0, 0, ...view.target]);
      device.queue.writeBuffer(viewBuffer, 0, viewData);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    destroy() {
      textures.forEach((t) => t.destroy());
      device.destroy();
    },
  };
}

async function createWebGl(canvas, scene) {
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
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, GL_VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, scene.glsl));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
  }
  gl.useProgram(program);
  const loc = (name) => gl.getUniformLocation(program, name);
  const uRes = loc("uRes");
  const uRot = loc("uRot");
  const uDist = loc("uDist");
  const uTime = loc("uTime");
  const uTarget = loc("uTarget");

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
    gl.uniform1i(loc(`imageTex${i}`), i);
    textures.push(texture);
  }

  return {
    draw(view) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform2f(uRot, view.rotX, view.rotY);
      gl.uniform1f(uDist, view.distance);
      gl.uniform1f(uTime, view.time);
      gl.uniform3f(uTarget, ...view.target);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      textures.forEach((t) => gl.deleteTexture(t));
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

export function mount(canvas, scene, options = {}) {
  const opts = { orbit: true, zoom: true, wheel: "auto", autoRotate: 0, maxDpr: 2, backend: "auto", ...options };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) opts.autoRotate = 0;
  const view = {
    rotX: scene.view.rotX,
    rotY: scene.view.rotY,
    distance: scene.view.distance,
    target: scene.view.target ?? [0, 0, 0],
    time: 0,
  };
  const fit = scene.view.fit ?? 0;
  // With `fit` the zoom is relative to the fitted distance, so it survives resizes.
  let zoom = scene.view.zoom ?? 1;
  let renderer = null;
  let dirty = true;
  let visible = true;
  let destroyed = false;
  let raf = 0;
  let last = performance.now();
  const start = last;

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
      view.distance = ((fit * 1.1) / Math.sin(halfFov)) * zoom;
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
    view.time = (now - start) / 1000;
    if (dirty && visible && renderer) {
      resize();
      renderer.draw(view);
      dirty = false;
    }
    if (opts.autoRotate || dirty) schedule();
  };
  const schedule = () => {
    if (!raf && !destroyed && visible) raf = requestAnimationFrame(frame);
  };
  const invalidate = () => {
    dirty = true;
    schedule();
  };

  // ── Interaction ──
  const report = () => opts.onView?.({ rotX: view.rotX, rotY: view.rotY, distance: view.distance, zoom });
  let reportTimer = 0;
  const reportSoon = () => {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(report, 250);
  };
  const zoomBy = (factor) => {
    if (fit) zoom = Math.min(5, Math.max(0.2, zoom * factor));
    else view.distance = Math.min(20, Math.max(0.5, view.distance * factor));
    invalidate();
    reportSoon();
  };

  let dragging = null;
  const touches = new Map(); // pointerId → { x, y }
  let pinch = 0; // finger spread at the last pinch step
  // Clicked into: a plain wheel zooms until the mouse leaves the canvas.
  let active = false;
  const spread = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const onDown = (e) => {
    if (e.button !== 0) return;
    active = true;
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && opts.zoom) {
        dragging = null;
        pinch = spread();
      }
      if (touches.size > 1) return;
    }
    if (!opts.orbit) return;
    dragging = { x: e.clientX, y: e.clientY, rotX: view.rotX, rotY: view.rotY, moved: false };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers cannot be captured.
    }
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const d = spread();
      if (d > 0) zoomBy(pinch / d);
      pinch = d;
      return;
    }
    if (!dragging) return;
    view.rotX = dragging.rotX + ((e.clientX - dragging.x) / canvas.clientWidth) * Math.PI * 2;
    view.rotY = dragging.rotY + ((e.clientY - dragging.y) / canvas.clientHeight) * Math.PI * 2;
    dragging.moved = true;
    invalidate();
  };
  const onUp = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = 0;
    if (dragging?.moved) report();
    dragging = null;
    canvas.style.cursor = opts.orbit ? "grab" : "";
  };
  const onLeave = (e) => {
    if (e.pointerType === "mouse") active = false;
  };

  // Would a plain wheel over the canvas scroll the page or a container?
  const scrollsAround = () => {
    for (let el = canvas.parentElement; el; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      if (el === document.scrollingElement || /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
    }
    return false;
  };
  let hint = null;
  let hintTimer = 0;
  const showHint = () => {
    if (!hint) {
      hint = document.createElement("div");
      hint.setAttribute("aria-hidden", "true");
      // Escaped: the host page may not be UTF-8.
      hint.textContent = `Hold ${/Mac|iPhone|iPad/.test(navigator.platform) ? "\u2318" : "Ctrl"} or click the scene to zoom`;
      Object.assign(hint.style, {
        position: "fixed",
        zIndex: "2147483647",
        transform: "translate(-50%, -50%)",
        padding: "7px 12px",
        borderRadius: "8px",
        background: "rgba(0, 0, 0, 0.75)",
        color: "#fff",
        font: "500 13px/1.3 system-ui, sans-serif",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.2s",
      });
      document.body.appendChild(hint);
    }
    const r = canvas.getBoundingClientRect();
    hint.style.left = `${r.left + r.width / 2}px`;
    hint.style.top = `${r.top + r.height / 2}px`;
    hint.style.opacity = "1";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (hint.style.opacity = "0"), 1200);
  };
  // ctrl/⌘ + wheel (and trackpad pinch, which arrives as ctrl + wheel) zooms.
  // A plain wheel zooms per `opts.wheel`; when it scrolls instead, a hint
  // says how to zoom.
  const onWheel = (e) => {
    if (!opts.zoom) return;
    const plain = !(e.ctrlKey || e.metaKey);
    if (plain && (opts.wheel === "modifier" || (opts.wheel !== "always" && !active && scrollsAround()))) {
      showHint();
      return;
    }
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomBy(Math.exp(px * 0.002));
  };
  // Safari reports trackpad pinches as gesture events instead (and touch
  // pinches as both: those zoom through the pointers).
  let gesture = 0;
  const onGestureStart = (e) => {
    if (!opts.zoom || touches.size > 1) return;
    e.preventDefault();
    gesture = 1;
  };
  const onGestureChange = (e) => {
    if (!gesture) return;
    e.preventDefault();
    zoomBy(gesture / e.scale);
    gesture = e.scale;
  };
  const onGestureEnd = (e) => {
    if (gesture) e.preventDefault();
    gesture = 0;
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("gesturestart", onGestureStart);
  canvas.addEventListener("gesturechange", onGestureChange);
  canvas.addEventListener("gestureend", onGestureEnd);
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
      return name === "webgpu" ? await createWebGpu(canvas, scene) : await createWebGl(canvas, scene);
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
    canvas.removeEventListener("gesturestart", onGestureStart);
    canvas.removeEventListener("gesturechange", onGestureChange);
    canvas.removeEventListener("gestureend", onGestureEnd);
    clearTimeout(reportTimer);
    clearTimeout(hintTimer);
    hint?.remove();
    renderer?.destroy();
  };
}
