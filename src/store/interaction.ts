/**
 * Interaction: reactions that move a shape or group when the viewer hovers
 * it, clicks it, or moves the pointer. A reaction adds `amount · state` to
 * one animatable number (same targets and units as animation tracks), where
 * state eases between 0 and 1 (hover, click toggle) or follows the pointer
 * across the canvas, −1 (left / top) … 1 (right / bottom).
 *
 * The editor applies reactions on the CPU in "Try" mode; embeds receive the
 * states as uniforms (see generateSdfCode `interactive`) and pick the hovered
 * item on the GPU (runtime.js).
 *
 * No imports from the scene store (persistence and the store depend on this).
 */
import { TARGET_LABEL, type Offset, type TrackTarget } from "./animation";

export type Trigger = "hover" | "click" | "pointerX" | "pointerY";

export type Reaction = {
  trigger: Trigger;
  target: TrackTarget;
  /** Change at full state, in the target's units (degrees, scale fraction…). */
  amount: number;
  off?: boolean;
};

export const MAX_REACTIONS = 8;
/** Items with hover / click reactions in one scene: their ids fit a byte in the embed pick. */
export const MAX_INTERACTIVE = 64;

export const TRIGGERS: Trigger[] = ["hover", "click", "pointerX", "pointerY"];

export const TRIGGER_LABEL: Record<Trigger, string> = {
  hover: "Hover",
  click: "Click (toggle)",
  pointerX: "Pointer left ↔ right",
  pointerY: "Pointer up ↕ down",
};

/** One-click starting points. "Up" is −Y in this editor. */
export const REACTION_PRESETS: { name: string; hint: string; reactions: Reaction[] }[] = [
  { name: "Grow", hint: "Grows a little while hovered", reactions: [{ trigger: "hover", target: "scale", amount: 0.15 }] },
  { name: "Lift", hint: "Rises while hovered", reactions: [{ trigger: "hover", target: "position.y", amount: -0.12 }] },
  { name: "Light up", hint: "Glows while hovered", reactions: [{ trigger: "hover", target: "emission", amount: 1.5 }] },
  { name: "Flip", hint: "Click turns it over, click again turns it back", reactions: [{ trigger: "click", target: "rotation.y", amount: 180 }] },
  {
    name: "Look at cursor",
    hint: "Turns toward the pointer",
    reactions: [
      { trigger: "pointerX", target: "rotation.y", amount: -35 },
      { trigger: "pointerY", target: "rotation.x", amount: 25 },
    ],
  },
  {
    name: "Follow cursor",
    hint: "Leans toward the pointer",
    reactions: [
      { trigger: "pointerX", target: "position.x", amount: 0.25 },
      { trigger: "pointerY", target: "position.y", amount: 0.15 },
    ],
  },
];

export function activeReactions(list: readonly Reaction[] | undefined): Reaction[] {
  return (list ?? []).filter((r) => !r.off);
}

/** Needs a per-item state (and a pick id in the embed). */
export const isItemTrigger = (t: Trigger) => t === "hover" || t === "click";

type Node = { id: string; kind: string; interaction?: Reaction[]; items?: unknown[] };

export function hasInteraction(items: readonly Node[]): boolean {
  for (const item of items) {
    if (activeReactions(item.interaction).length > 0) return true;
    if (Array.isArray(item.items) && hasInteraction(item.items as Node[])) return true;
  }
  return false;
}

/**
 * Items with hover / click reactions, in tree order (their slot = index),
 * each with the slot of its nearest interactive ancestor (−1 for none).
 * Capped at MAX_INTERACTIVE; items past the cap stay at rest.
 */
export interface InteractiveSlots {
  ids: string[];
  slot: Map<string, number>;
  parent: number[];
  clickable: boolean[];
  hoverable: boolean[];
  /** Something reacts to the pointer position. */
  pointer: boolean;
}

export function interactiveSlots(items: readonly Node[]): InteractiveSlots {
  const out: InteractiveSlots = { ids: [], slot: new Map(), parent: [], clickable: [], hoverable: [], pointer: false };
  const walk = (list: readonly Node[], parent: number) => {
    for (const item of list) {
      const reactions = activeReactions(item.interaction);
      if (reactions.some((r) => !isItemTrigger(r.trigger))) out.pointer = true;
      let own = parent;
      if (reactions.some((r) => isItemTrigger(r.trigger)) && out.ids.length < MAX_INTERACTIVE) {
        own = out.ids.length;
        out.slot.set(item.id, own);
        out.ids.push(item.id);
        out.parent.push(parent);
        out.clickable.push(reactions.some((r) => r.trigger === "click"));
        out.hoverable.push(reactions.some((r) => r.trigger === "hover"));
      }
      if (Array.isArray(item.items)) walk(item.items as Node[], own);
    }
  };
  walk(items, -1);
  return out;
}

/** The slot and every interactive ancestor's, innermost first. */
export function slotChain(slots: Pick<InteractiveSlots, "parent">, slot: number): number[] {
  const chain: number[] = [];
  for (let s = slot; s >= 0 && chain.length <= MAX_INTERACTIVE; s = slots.parent[s]) chain.push(s);
  return chain;
}

/** What the viewer is doing, eased: per-item hover / click in 0..1, pointer in −1..1. */
export interface InteractionState {
  hover: ReadonlyMap<string, number>;
  click: ReadonlyMap<string, number>;
  pointer: readonly [number, number];
}

export const REST_STATE: InteractionState = { hover: new Map(), click: new Map(), pointer: [0, 0] };

export function reactionValue(r: Reaction, id: string, s: InteractionState): number {
  switch (r.trigger) {
    case "hover":
      return r.amount * (s.hover.get(id) ?? 0);
    case "click":
      return r.amount * (s.click.get(id) ?? 0);
    case "pointerX":
      return r.amount * s.pointer[0];
    case "pointerY":
      return r.amount * s.pointer[1];
  }
}

/** Offsets for evaluateAnimations' `extra`. */
export function reactionOffsets(item: Node, s: InteractionState): Offset[] {
  const reactions = activeReactions(item.interaction);
  if (reactions.length === 0) return [];
  const out: Offset[] = [];
  for (const r of reactions) {
    const value = reactionValue(r, item.id, s);
    if (value !== 0) out.push({ target: r.target, value });
  }
  return out;
}

/**
 * Exponential ease toward `target` (≈ 90% in 0.2 s), snapping when close.
 * Returns the new value.
 */
export function easeToward(value: number, target: number, dt: number): number {
  const next = value + (target - value) * Math.min(1, dt * 12);
  return Math.abs(target - next) < 0.002 ? target : next;
}

// ── Sanitizing (trust boundary) ─────────────────────────────────────────────

const TARGETS = Object.keys(TARGET_LABEL) as TrackTarget[];

export function sanitizeReaction(raw: unknown): Reaction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!TRIGGERS.includes(r.trigger as Trigger)) return undefined;
  if (!TARGETS.includes(r.target as TrackTarget)) return undefined;
  const amount = typeof r.amount === "number" && Number.isFinite(r.amount) ? Math.min(1e4, Math.max(-1e4, r.amount)) : 0;
  return {
    trigger: r.trigger as Trigger,
    target: r.target as TrackTarget,
    amount,
    ...(r.off === true ? { off: true } : {}),
  };
}

export function sanitizeReactions(list: unknown): Reaction[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out = list.map(sanitizeReaction).filter((r): r is Reaction => !!r).slice(0, MAX_REACTIONS);
  return out.length > 0 ? out : undefined;
}
