import { useEffect, useMemo, useRef, useState } from "react";
import { useSceneStore } from "../../store/sceneStore";
import { useRenderStore, type RenderMode } from "../../store/renderStore";
import type { EmbedStyle } from "../../export/renderTemplates";
import { useExportStore } from "../../store/exportStore";
import { useTimelineStore } from "../../store/timelineStore";
import { useViewStore } from "../../store/viewStore";
import { generateSdfCode, type CodeLang } from "../../utils/generateSdfCode";
import { exportFileName, generateEmbed } from "../../export/embed";
import { IMAGE_SDF_PREFIX } from "../../utils/imageSdf";
import { EmbedPanel } from "./EmbedPanel";

// Baked image PNGs are tens of KB per line: show an ellipsis, copy the real thing.
const DATA_URL_RE = new RegExp(`${IMAGE_SDF_PREFIX}[A-Za-z0-9+/=]+`, "g");
const elide = (code: string) => code.replace(DATA_URL_RE, `${IMAGE_SDF_PREFIX}…`);

type Tab = "embed" | "shadertoy" | CodeLang;

/** Embed / Shadertoy export the whole scene; the SDF tabs follow the selection. */
const LANGS: { id: Tab; label: string; shiki: string; title: string }[] = [
  { id: "embed", label: "Embed", shiki: "html", title: "Drop-in scene for any web page" },
  { id: "shadertoy", label: "Shadertoy", shiki: "glsl", title: "Paste into Shadertoy's Image tab" },
  { id: "typegpu", label: "TypeGPU", shiki: "typescript", title: "SDF function (selection or scene)" },
  { id: "wgsl", label: "WGSL", shiki: "wgsl", title: "SDF function (selection or scene)" },
  { id: "glsl", label: "GLSL", shiki: "glsl", title: "SDF function (selection or scene)" },
];

const LS_TAB = "d-stance_code_tab";

function loadTab(): Tab {
  try {
    const t = localStorage.getItem(LS_TAB);
    if (LANGS.some((l) => l.id === t)) return t as Tab;
  } catch {
    /* ignore */
  }
  return "embed";
}

// ── Lazy shiki highlighter (loaded on first Code tab open) ───────────────────

type Highlighter = { codeToHtml(code: string, opts: { lang: string; theme: string }): string };

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, ts, wgsl, glsl, html, js, theme] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/wgsl"),
        import("@shikijs/langs/glsl"),
        import("@shikijs/langs/html"),
        import("@shikijs/langs/javascript"),
        import("@shikijs/themes/github-dark-default"),
      ]);
    return createHighlighterCore({
      langs: [ts.default, wgsl.default, glsl.default, html.default, js.default],
      themes: [theme.default],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighterPromise;
}

/** Inspect modes (Field, Cost, Normals) are editor tools: the embed shows Classic. */
function editorStyle(mode: RenderMode): EmbedStyle {
  return mode === "field" || mode === "cost" || mode === "normals" ? "classic" : mode;
}

export default function CodeView() {
  const root = useSceneStore((s) => s.root);
  const selectedItemId = useSceneStore((s) => s.selectedItemId);
  const renderMode = useRenderStore((s) => s.renderMode);
  const view = useViewStore();
  const { look, background, motion, quality, format, framing } = useExportStore();
  const [lang, setLangState] = useState<Tab>(loadTab);
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  const setLang = (t: Tab) => {
    setLangState(t);
    try {
      localStorage.setItem(LS_TAB, t);
    } catch {
      /* ignore */
    }
  };

  const isScene = lang === "embed" || lang === "shadertoy";
  const loop = useTimelineStore((s) => s.duration);
  const generated = useMemo(
    () => (isScene ? null : generateSdfCode(root, selectedItemId)),
    [isScene, root, selectedItemId],
  );
  const exp = useMemo(
    () =>
      isScene
        ? generateEmbed(root, {
            style: look === "editor" ? editorStyle(renderMode) : look,
            background,
            motion,
            quality,
            framing,
            view: { rotX: view.rotX, rotY: view.rotY, distance: view.distance },
            loop,
          })
        : null,
    [isScene, root, look, renderMode, background, motion, quality, framing, view.rotX, view.rotY, view.distance, loop],
  );
  const code = exp
    ? lang === "shadertoy"
      ? exp.shadertoy
      : format === "module"
        ? exp.module
        : exp.html
    : generated![lang as CodeLang];
  const shikiLang =
    lang === "embed" && format === "module" ? "javascript" : LANGS.find((l) => l.id === lang)!.shiki;
  const shownNow = useMemo(() => elide(code), [code]);
  // Highlighting a full embed takes a while: wait until edits settle.
  const [shown, setShown] = useState(shownNow);
  useEffect(() => {
    if (shown === shownNow) return;
    const id = setTimeout(() => setShown(shownNow), isScene ? 250 : 0);
    return () => clearTimeout(id);
  }, [shownNow, shown, isScene]);

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then(
      (hl) => {
        if (!cancelled)
          setHtml(hl.codeToHtml(shown, { lang: shikiLang, theme: "github-dark-default" }));
      },
      () => {
        if (!cancelled) setHtml(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [shown, shikiLang]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  // Drag-to-scroll for the language strip; a click after a real drag is ignored.
  const stripRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ startX: 0, startScroll: 0, moved: false });

  function onStripPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const strip = stripRef.current;
    if (!strip) return;
    drag.current = { startX: e.clientX, startScroll: strip.scrollLeft, moved: false };
  }

  function onStripPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const strip = stripRef.current;
    if (!strip || e.buttons !== 1) return;
    const dx = e.clientX - drag.current.startX;
    // Capture only once a real drag starts, so plain clicks reach the buttons.
    if (!drag.current.moved && Math.abs(dx) <= 4) return;
    if (!drag.current.moved) {
      drag.current.moved = true;
      strip.setPointerCapture(e.pointerId);
    }
    strip.scrollLeft = drag.current.startScroll - dx;
  }

  function selectLang(id: Tab) {
    if (drag.current.moved) return;
    setLang(id);
  }

  return (
    <div className="code-view">
      <div
        ref={stripRef}
        className="code-langs"
        onPointerDown={onStripPointerDown}
        onPointerMove={onStripPointerMove}
      >
        {LANGS.map((l) => (
          <button
            key={l.id}
            className={`code-lang${lang === l.id ? " code-lang--active" : ""}`}
            title={l.title}
            onClick={() => selectLang(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>
      {lang === "embed" && exp && <EmbedPanel exp={exp} fileName={exportFileName(root, format)} />}
      {lang === "shadertoy" && exp && exp.shadertoyDropped > 0 && (
        <p className="code-note">
          {exp.shadertoyDropped} image layer{exp.shadertoyDropped > 1 ? "s are" : " is"} left out — Shadertoy
          cannot load custom textures.
        </p>
      )}
      <div className="code-body">
        <button
          className="code-copy-btn"
          onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        {html && shown === shownNow ? (
          <div className="code-pre" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="code-pre">{shownNow}</pre>
        )}
      </div>
    </div>
  );
}
