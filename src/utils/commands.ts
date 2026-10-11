import { maskIcon, type IconComponent } from "../components/MaskIcon";
import {
  MAX_IMAGES,
  useSceneStore,
  wouldExceedDepth,
  wouldExceedImages,
  shapeLabel,
  type ShapeType,
} from "../store/sceneStore";
import { duplicateSelection } from "../scene/clipboard";
import { showToast } from "./toast";
import { isImageFile } from "./decodeImage";
import { DEFAULT_TEXT, TEXT_PARAMS, bakeText, textLayerName } from "./textSdf";

const SHAPE_ICON_URLS = import.meta.glob<string>("../assets/shape-icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
});

/** Icons are generated SVGs (flat, toned like the op icons) named after the shape. */
function shapeIcon(name: string): IconComponent {
  const url = SHAPE_ICON_URLS[`../assets/shape-icons/${name}.svg`];
  if (!url) throw new Error(`Missing shape icon: ${name}.svg`);
  return maskIcon(url);
}

// Explicit Record: a shape type without an icon fails typecheck.
export const SHAPE_ICONS: Record<ShapeType, IconComponent> = {
  sphere: shapeIcon("sphere"),
  box: shapeIcon("box"),
  torus: shapeIcon("torus"),
  cylinder: shapeIcon("cylinder"),
  capsule: shapeIcon("capsule"),
  cone: shapeIcon("cone"),
  roundedBox: shapeIcon("roundedBox"),
  boxFrame: shapeIcon("boxFrame"),
  cappedTorus: shapeIcon("cappedTorus"),
  link: shapeIcon("link"),
  hexPrism: shapeIcon("hexPrism"),
  triPrism: shapeIcon("triPrism"),
  roundedCylinder: shapeIcon("roundedCylinder"),
  roundCone: shapeIcon("roundCone"),
  solidAngle: shapeIcon("solidAngle"),
  cutSphere: shapeIcon("cutSphere"),
  cutHollowSphere: shapeIcon("cutHollowSphere"),
  deathStar: shapeIcon("deathStar"),
  rhombus: shapeIcon("rhombus"),
  octahedron: shapeIcon("octahedron"),
  pyramid: shapeIcon("pyramid"),
  vesica: shapeIcon("vesica"),
  terrain: shapeIcon("terrain"),
  gyroid: shapeIcon("gyroid"),
  formula: shapeIcon("formula"),
  image: shapeIcon("image"),
};

export const GROUP_ICON = shapeIcon("group");
export const IMAGE_ADD_ICON = shapeIcon("imageAdd");
export const TEXT_ICON = shapeIcon("text");
export const DUPLICATE_ICON = shapeIcon("duplicate");
export const COPY_LINK_ICON = shapeIcon("copyLink");
export const COPIED_ICON = shapeIcon("copied");
export const GIZMO_ICONS = {
  translate: shapeIcon("gizmoMove"),
  rotate: shapeIcon("gizmoRotate"),
  scale: shapeIcon("gizmoScale"),
};
export const RENDER_MODE_ICONS = {
  classic: shapeIcon("renderClassic"),
  chrome: shapeIcon("renderChrome"),
  studio: shapeIcon("renderStudio"),
};

function shapeEntry(type: ShapeType) {
  return { type, label: shapeLabel(type), icon: SHAPE_ICONS[type] };
}

/** Toolbar shapes — digit hotkeys 1–6. */
export const SHAPES: { type: ShapeType; label: string; icon: IconComponent }[] = (
  ["box", "sphere", "torus", "cylinder", "capsule", "cone"] as ShapeType[]
).map(shapeEntry);

/** Image import sits right after the toolbar shapes: hotkey 7. */
export const IMAGE_HOTKEY = String(SHAPES.length + 1);
/** Then text: hotkey 8. */
export const TEXT_HOTKEY = String(SHAPES.length + 2);

/** Remaining shapes — command palette only. */
export const EXTRA_SHAPES: typeof SHAPES = (
  [
    "roundedBox",
    "boxFrame",
    "cappedTorus",
    "link",
    "hexPrism",
    "triPrism",
    "roundedCylinder",
    "roundCone",
    "solidAngle",
    "cutSphere",
    "cutHollowSphere",
    "deathStar",
    "rhombus",
    "octahedron",
    "pyramid",
    "vesica",
    "terrain",
    "gyroid",
    "formula",
  ] as ShapeType[]
).map(shapeEntry);

export function addShape(type: ShapeType) {
  const { addShapeToContainer, selectedContainerId } = useSceneStore.getState();
  if (!addShapeToContainer(selectedContainerId, type)) {
    showToast("Scene too complex (max 256 operations)");
  }
}

/** A text layer ("Hello", bold Inter), selected so its words can be typed over at once. */
export async function addText() {
  const sdf = await bakeText(DEFAULT_TEXT);
  if (!sdf) return;
  const st = useSceneStore.getState();
  if (wouldExceedImages(st.root, sdf)) {
    showToast(`Too many images and texts (max ${MAX_IMAGES})`);
    return;
  }
  const opts = { name: textLayerName(DEFAULT_TEXT.content), params: TEXT_PARAMS };
  if (!st.addShapeToContainer(st.selectedContainerId, "image", { sdf, text: { ...DEFAULT_TEXT } }, opts)) {
    showToast("Scene too complex (max 256 operations)");
  }
}

export function addGroup() {
  const state = useSceneStore.getState();
  if (!state.addGroupToContainer(state.selectedContainerId)) {
    showToast(
      wouldExceedDepth(state.root, state.selectedContainerId)
        ? "Nesting too deep (max 16 levels)"
        : "Scene too complex (max 256 operations)",
    );
  }
}

export type Command = {
  id: string;
  label: string;
  icon: IconComponent;
  hotkey?: string;
  keywords?: string[];
  run: () => void;
};

export const COMMANDS: Command[] = [
  ...SHAPES.map(({ type, label, icon }, i) => ({
    id: `add-${type}`,
    label: `Add ${label}`,
    icon,
    hotkey: String(i + 1),
    run: () => addShape(type),
  })),
  {
    id: "add-text",
    label: "Add Text",
    icon: TEXT_ICON,
    hotkey: TEXT_HOTKEY,
    keywords: ["text", "type", "font", "letters", "word", "title", "logo", "3d text"],
    run: () => void addText(),
  },
  {
    id: "add-image",
    label: "Add Image (logo to SDF)",
    icon: IMAGE_ADD_ICON,
    hotkey: IMAGE_HOTKEY,
    keywords: ["image", "logo", "picture", "png", "svg", "import", "extrude"],
    run: () => pickImageFile(),
  },
  ...EXTRA_SHAPES.map(({ type, label, icon }) => ({
    id: `add-${type}`,
    label: `Add ${label}`,
    icon,
    keywords: ["shape", "primitive"],
    run: () => addShape(type),
  })),
  {
    id: "add-group",
    label: "Add Object (group)",
    icon: GROUP_ICON,
    keywords: ["group", "container", "folder", "nest"],
    run: addGroup,
  },
  {
    id: "duplicate",
    label: "Duplicate Selected",
    icon: DUPLICATE_ICON,
    hotkey: "⌘D",
    keywords: ["copy", "clone", "paste"],
    run: duplicateSelection,
  },
];

/** Opens the OS file picker; the chosen image goes to the import dialog. */
export function pickImageFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,.svg";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) openImageImport(file);
  };
  input.click();
}

let imageImportListener: ((file: File) => void) | null = null;

export function setImageImportListener(fn: ((file: File) => void) | null) {
  imageImportListener = fn;
}

export function openImageImport(file: File) {
  if (!isImageFile(file)) {
    showToast("Not an image file");
    return;
  }
  imageImportListener?.(file);
}
