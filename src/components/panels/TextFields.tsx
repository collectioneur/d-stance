import { useEffect, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import { MAX_IMAGES, collectImageSdfs, useSceneStore, type ShapeLayer } from "../../store/sceneStore";
import {
  MAX_SPACING_EM,
  MAX_TEXT_CHARS,
  MIN_SPACING_EM,
  TEXT_FONTS,
  bakeText,
  cleanText,
  customFamily,
  customFont,
  textLayerName,
  type TextAlign,
  type TextSpec,
} from "../../utils/textSdf";
import { showToast } from "../../utils/toast";
import { NumberField } from "./fields";

const ALIGNS: { value: TextAlign; label: string; Icon: typeof AlignLeft }[] = [
  { value: "left", label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Align center", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
];

/** Typing settles this long before a re-bake (~40–80 ms of CPU each). */
const BAKE_DELAY_MS = 120;

/**
 * Words and font of a text layer. Every change re-bakes the layer's SDF;
 * the layer keeps its name in step with its words until it is renamed.
 */
export function TextFields({ layer, spaced }: { layer: ShapeLayer & { image: { text: TextSpec } }; spaced?: boolean }) {
  const updateItems = useSceneStore((s) => s.updateItems);
  const spec = layer.image.text;
  const [draft, setDraft] = useState(spec.content);
  const [customDraft, setCustomDraft] = useState(customFamily(spec.font) ?? "");
  const pending = useRef<{ spec: TextSpec; timer: number } | null>(null);
  const run = useRef(0);

  // Undo / another selection: follow the stored words.
  useEffect(() => setDraft(spec.content), [layer.id, spec.content]);

  const bake = async (next: TextSpec) => {
    const ticket = ++run.current;
    const sdf = await bakeText(next);
    if (ticket !== run.current) return; // a newer edit is on its way
    const { root } = useSceneStore.getState();
    if (!sdf) {
      // Nothing to draw: keep the last shape, remember the words.
      updateItems([layer.id], (it) => (it.kind === "layer" && it.image ? { ...it, image: { ...it.image, text: next } } : it));
      return;
    }
    // This layer's old SDF frees its slot unless another layer shares it.
    const others = collectImageSdfs(withoutLayer(root.items, layer.id));
    if (!others.has(sdf) && others.size >= MAX_IMAGES) {
      showToast(`Too many images and texts (max ${MAX_IMAGES})`);
      return;
    }
    updateItems([layer.id], (it) => {
      if (it.kind !== "layer" || !it.image) return it;
      const named = it.name === textLayerName(it.image.text?.content ?? "") ? { name: textLayerName(next.content) } : {};
      return { ...it, ...named, image: { ...it.image, sdf, text: next } };
    });
  };

  const change = (patch: Partial<TextSpec>, delay = 0) => {
    const next = { ...(pending.current?.spec ?? spec), ...patch };
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = {
      spec: next,
      timer: window.setTimeout(() => {
        pending.current = null;
        void bake(next);
      }, delay),
    };
  };

  useEffect(
    () => () => {
      // Leaving the layer: finish the edit in flight.
      if (pending.current) {
        clearTimeout(pending.current.timer);
        void bake(pending.current.spec);
        pending.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer.id],
  );

  const fontKey = customFamily(spec.font) ? "custom" : spec.font;
  const multiline = draft.includes("\n");

  return (
    <>
      <div className="props-section-title" style={{ marginTop: spaced ? "16px" : undefined }}>
        Text
      </div>
      <textarea
        className="formula-input text-input"
        aria-label="Text"
        value={draft}
        rows={Math.min(4, Math.max(1, draft.split("\n").length))}
        maxLength={MAX_TEXT_CHARS}
        spellCheck={false}
        placeholder="Type something"
        onChange={(e) => {
          const content = cleanText(e.target.value);
          setDraft(content);
          change({ content }, BAKE_DELAY_MS);
        }}
      />
      <div className="prop-row">
        <label className="prop-label">Font</label>
        <select
          className="prop-input prop-select"
          aria-label="Font"
          value={fontKey}
          onChange={(e) => {
            const key = e.target.value;
            if (key !== "custom") {
              change({ font: key });
              return;
            }
            const family = customDraft || "Arial";
            setCustomDraft(family);
            change({ font: customFont(family) });
          }}
        >
          {TEXT_FONTS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
          <option value="custom">Installed font…</option>
        </select>
      </div>
      {fontKey === "custom" && (
        <div className="prop-row">
          <label className="prop-label">Family</label>
          <input
            className="prop-input"
            aria-label="Font family"
            value={customDraft}
            maxLength={40}
            spellCheck={false}
            placeholder="e.g. Helvetica"
            onChange={(e) => {
              const family = e.target.value;
              setCustomDraft(family);
              if (customFamily(customFont(family))) change({ font: customFont(family) }, BAKE_DELAY_MS * 3);
            }}
          />
        </div>
      )}
      <div className="prop-row">
        <label className="prop-label">Weight</label>
        <NumberField
          ariaLabel="Weight"
          value={spec.weight}
          min={100}
          max={900}
          step={100}
          decimals={0}
          fallback={800}
          onChange={(weight) => change({ weight: Math.round(weight) })}
        />
      </div>
      <div className="prop-row">
        <label className="prop-label">Spacing</label>
        <NumberField
          ariaLabel="Letter spacing"
          value={spec.spacing}
          min={MIN_SPACING_EM}
          max={MAX_SPACING_EM}
          step={0.01}
          decimals={2}
          fallback={0}
          onChange={(spacing) => change({ spacing })}
        />
      </div>
      <div className="prop-row">
        <label className="prop-label">Italic</label>
        <input
          className="ui-check"
          type="checkbox"
          aria-label="Italic"
          checked={spec.italic}
          onChange={(e) => change({ italic: e.target.checked })}
        />
      </div>
      {multiline && (
        <div className="prop-row">
          <label className="prop-label">Align</label>
          <div className="axis-picker" role="radiogroup" aria-label="Align">
            {ALIGNS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={spec.align === value}
                title={label}
                aria-label={label}
                className={`axis-picker-btn${spec.align === value ? " axis-picker-btn--active" : ""}`}
                onClick={() => change({ align: value })}
              >
                <Icon size={12} />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function withoutLayer<T extends { id: string; kind: string; items?: T[] }>(items: T[], id: string): T[] {
  return items
    .filter((it) => it.id !== id)
    .map((it) => (it.kind === "group" && it.items ? { ...it, items: withoutLayer(it.items, id) } : it));
}
