import { useEffect, useRef, useState } from "react";
import logo from "../assets/logo.png";

/**
 * The logo "d", ray-marched live in chrome and slowly swaying. WebGL2 (phones
 * often lack WebGPU), self-contained: nothing here touches the editor renderer.
 * Same geometry as the rendered logo: a torus bowl smooth-unioned with a link.
 */
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uAngle;
out vec4 outColor;

float sdTorus(vec3 p, float R, float r) { return length(vec2(length(p.xz) - R, p.y)) - r; }
float sdLink(vec3 p, float le, float r1, float r2) {
  vec3 q = vec3(p.x, max(abs(p.y) - le, 0.0), p.z);
  return length(vec2(length(q.xy) - r1, q.z)) - r2;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Logo in d-stance space (+y down), recentred on its bounding box.
float map(vec3 p) {
  float c = cos(uAngle), s = sin(uAngle);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  vec3 a = vec3(p.x + 0.06, -p.y - 0.06, p.z);
  vec3 b = a - vec3(-0.27, 0.56, 0.0);
  float bowl = sdTorus(vec3(b.x, b.z, -b.y), 0.35, 0.16); // turned to face the camera
  float stem = sdLink(a - vec3(0.53, -0.06, 0.0), 0.76, 0.22, 0.15);
  return smin(bowl, stem, 0.32);
}

vec3 normalAt(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0008;
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) +
                   k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

// The editor's chrome studio: two vertical softboxes and one overhead.
vec3 env(vec3 r) {
  float v = mix(0.015, 0.06, r.y * 0.5 + 0.5);
  vec2 h = r.xz / max(length(r.xz), 1e-4);
  v += pow(max(-h.x * 0.7071 - h.y * 0.7071, 0.0), 22.0) * (1.0 - smoothstep(0.55, 0.9, abs(r.y))) * 3.2;
  v += pow(max(h.x * 0.866 - h.y * 0.5, 0.0), 40.0) * (1.0 - smoothstep(0.5, 0.85, abs(r.y))) * 2.2;
  v += smoothstep(0.35, 0.85, r.y) * 1.4 + smoothstep(0.3, 0.9, -r.y) * 0.05;
  return vec3(v);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec4 shade(vec2 frag) {
  vec2 uv = (frag / uRes) * 2.0 - 1.0;
  uv.x *= uRes.x / uRes.y;
  vec3 ro = vec3(0.0, 0.0, -4.0);
  vec3 rd = normalize(vec3(uv, 2.8));
  float t = 2.4;
  for (int i = 0; i < 96; i++) {
    float d = map(ro + rd * t);
    if (d < 0.0008) {
      vec3 p = ro + rd * t;
      vec3 n = normalAt(p);
      vec3 v = -rd;
      float fres = 0.55 + 0.45 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
      vec3 l = normalize(vec3(-1.5, 2.5, -2.0));
      float spec = pow(max(dot(n, normalize(l + v)), 0.0), 220.0) * 2.5;
      vec3 col = aces(env(reflect(rd, n)) * fres + spec);
      return vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
    }
    t += d;
    if (t > 7.0) break;
  }
  return vec4(0.0);
}

void main() {
  // 2×2 supersampling; premultiplied alpha for the transparent canvas.
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      vec4 c = shade(gl_FragCoord.xy + (vec2(i, j) - 0.5) * 0.5);
      acc += vec4(c.rgb * c.a, c.a);
    }
  outColor = acc / 4.0;
}`;

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export default function LogoSpinner({ width = 84, height = 112 }: { width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
    if (!canvas || !gl) {
      setFallback(true);
      return;
    }
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (vs && fs) {
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
    }
    if (!vs || !fs || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFallback(true);
      return;
    }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(program, "uRes"), canvas.width, canvas.height);
    const uAngle = gl.getUniformLocation(program, "uAngle");

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      // Sway, not spin: from behind the d would read as a b.
      const t = (now - start) / 1000;
      gl.uniform1f(uAngle, still ? 0.3 : 0.45 * Math.sin(t * 0.7));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    // No loseContext() here: StrictMode re-runs this effect on the same canvas,
    // and a lost context can't be reused. The browser frees it with the canvas.
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  if (fallback) {
    return <img className="logo-spinner" src={logo} alt="d-stance" style={{ height }} />;
  }
  return (
    <canvas
      ref={canvasRef}
      className="logo-spinner"
      role="img"
      aria-label="d-stance logo"
      style={{ width, height }}
    />
  );
}
