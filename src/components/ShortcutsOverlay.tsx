import { useEffect, useState } from "react";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Add",
    keys: [
      ["1 – 6", "Box, sphere, torus, cylinder, capsule, cone"],
      ["7", "Image (or paste / drop one)"],
      ["8", "Text"],
      [`${MOD} K  ·  Shift A`, "All commands and shapes"],
    ],
  },
  {
    title: "Edit",
    keys: [
      ["W  E  R", "Move, rotate, scale"],
      [`${MOD} D`, "Duplicate"],
      [`${MOD} C  ·  ${MOD} V`, "Copy, paste"],
      ["Delete", "Remove the selection"],
      [`${MOD} Z  ·  ${MOD} ⇧ Z`, "Undo, redo"],
    ],
  },
  {
    title: "Sculpt",
    keys: [
      ["B", "Sculpt on / off"],
      ["Alt + drag", "The other brush (clay ↔ carve)"],
      ["[  ]", "Brush size"],
      ["Right-drag  ·  ⌘-drag", "Orbit while sculpting"],
    ],
  },
  {
    title: "View & play",
    keys: [
      ["Drag  ·  scroll", "Orbit, zoom"],
      ["Space", "Play / pause animation"],
      ["Esc", "Leave sculpt / Try mode, close dialogs"],
      ["?", "This list"],
    ],
  },
];

const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.tagName === "SELECT" || !!el?.isContentEditable;
};

/** Every keyboard shortcut, on `?`. */
export default function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return (
    <div className="image-dialog-overlay" data-state="open" onClick={() => setOpen(false)}>
      <div className="image-dialog shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="image-dialog-title">Keyboard shortcuts</div>
        <div className="shortcuts-grid">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.keys.map(([k, what]) => (
                  <div key={k} className="shortcuts-row">
                    <dt>
                      {k.split("  ").map((part, i) => (
                        <kbd key={i}>{part}</kbd>
                      ))}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
