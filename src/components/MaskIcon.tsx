import type { ComponentType } from "react";

/** What icon slots accept: lucide icons and mask icons alike. */
export type IconComponent = ComponentType<{ size?: number }>;

/** An SVG drawn through a CSS mask, so it takes `currentColor` (and keeps its tone opacities). */
export function maskIcon(url: string): IconComponent {
  const image = `url("${url}")`;
  function MaskIcon({ size = 14 }: { size?: number }) {
    return (
      <span
        className="mask-icon"
        aria-hidden="true"
        style={{ width: size, height: size, maskImage: image, WebkitMaskImage: image }}
      />
    );
  }
  return MaskIcon;
}
