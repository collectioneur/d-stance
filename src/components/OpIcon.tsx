import type { OpType } from "../store/sceneStore";
import union from "../assets/op-icons/union.svg?url";
import subtract from "../assets/op-icons/subtract.svg?url";
import intersect from "../assets/op-icons/intersect.svg?url";
import smoothUnion from "../assets/op-icons/smooth-union.svg?url";
import smoothSubtract from "../assets/op-icons/smooth-subtract.svg?url";
import smoothIntersect from "../assets/op-icons/smooth-intersect.svg?url";

const OP_ICON_URL: Record<OpType, string> = {
  union,
  subtract,
  intersect,
  sUnion: smoothUnion,
  sSubtract: smoothSubtract,
  sIntersect: smoothIntersect,
};

/** SVG used as a mask so it takes `currentColor` (and keeps its ghost opacity). */
export function OpIcon({ op, size = 14 }: { op: OpType; size?: number }) {
  const url = `url("${OP_ICON_URL[op]}")`;
  return (
    <span
      className="op-icon"
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: url, WebkitMaskImage: url }}
    />
  );
}
