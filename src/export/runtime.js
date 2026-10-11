// d-stance embed runtime — draws an exported SDF scene into a <canvas>.
// WebGPU when available, WebGL2 otherwise. No dependencies.
//
//   const stop = mount(canvas, scene, { autoRotate: 0.3 });
//   stop(); // detach listeners, free the GPU
//
// scene = { wgsl, glsl, images: [pngDataUrl],
//           view: { rotX, rotY, distance, target: [x, y, z], fit?: radius } }
// With `fit`, the distance adapts to the canvas so a sphere of that radius
// around `target` stays in frame (until the user zooms).
// options: orbit (drag to rotate), zoom (ctrl/⌘ + wheel or pinch, so page
// scrolling is never hijacked), autoRotate (rad/s), maxDpr, backend
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
  const opts = { orbit: true, zoom: true, autoRotate: 0, animate: true, maxDpr: 2, backend: "auto", ...options };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
    if (dirty && visible && renderer) {
      resize();
      renderer.draw(view);
      dirty = false;
    }
    if (opts.autoRotate || loop || dirty) schedule();
  };
  const schedule = () => {
    if (!raf && !destroyed && visible) raf = requestAnimationFrame(frame);
  };
  const invalidate = () => {
    dirty = true;
    schedule();
  };

  // ── Interaction ──
  let dragging = null;
  const onDown = (e) => {
    if (!opts.orbit || e.button !== 0) return;
    dragging = { x: e.clientX, y: e.clientY, rotX: view.rotX, rotY: view.rotY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e) => {
    if (!dragging) return;
    view.rotX = dragging.rotX + ((e.clientX - dragging.x) / canvas.clientWidth) * Math.PI * 2;
    view.rotY = dragging.rotY + ((e.clientY - dragging.y) / canvas.clientHeight) * Math.PI * 2;
    invalidate();
  };
  const onUp = () => {
    dragging = null;
    canvas.style.cursor = opts.orbit ? "grab" : "";
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
  canvas.addEventListener("wheel", onWheel, { passive: false });
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
    canvas.removeEventListener("wheel", onWheel);
    renderer?.destroy();
  };
}
