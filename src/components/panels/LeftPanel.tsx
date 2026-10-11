import { memo, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Tree,
  type CursorProps,
  type DragPreviewProps,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from "react-arborist";
import { useTreeApi } from "react-arborist/dist/module/context.js";
import {
  arboristChildrenAccessor,
  canDropAt,
  sceneRootToArborist,
  type ArboristNode,
} from "../../scene/arboristAdapter";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Wand2,
  X,
} from "lucide-react";
import { GROUP_ICON, SHAPE_ICONS } from "../../utils/commands";
import { OpIcon } from "../OpIcon";
import { useElementSize } from "../../hooks/useElementSize";
import {
  useSceneStore,
  findContainer,
  findItem,
  wouldExceedCap,
  wouldExceedDepth,
} from "../../store/sceneStore";
import { showToast } from "../../utils/toast";


const TREE_INDENT = 12;

function SceneNode({
  node,
  style,
  dragHandle,
  preview,
}: NodeRendererProps<ArboristNode>) {
  const root = useSceneStore((s) => s.root);
  const removeItem = useSceneStore((s) => s.removeItem);
  const data = node.data;
  const isRoot = data.kind === "root";
  const isGroup = data.kind === "group";
  const showOp = !isRoot && node.childIndex > 0 && data.op;

  const containerId = useMemo(() => {
    const found = findItem(root, data.id);
    return found?.container.id ?? root.id;
  }, [root, data.id]);

  const isEditing = node.isEditing && !preview;

  const itemClass = [
    "scene-item",
    isRoot && "scene-item--root",
    !preview && node.isSelected && "scene-item--selected",
    !preview && node.willReceiveDrop && "scene-item--drop-target",
    !preview && node.isDragging && "scene-item--dragging",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      // No drag handle while renaming: selecting text in the field must not drag the row.
      ref={preview || isEditing ? undefined : dragHandle}
      style={style}
      className={itemClass}
      onClick={
        preview
          ? undefined
          : (e) => {
              // Arborist's own handler (also bound on its row wrapper) only knows
              // metaKey; accept Ctrl too, and keep it from toggling a second time.
              e.stopPropagation();
              if (e.metaKey || e.ctrlKey) {
                if (node.isSelected) node.deselect();
                else node.selectMulti();
              } else if (e.shiftKey) {
                node.selectContiguous();
              } else {
                node.select();
              }
            }
      }
      onDoubleClick={
        preview
          ? undefined
          : (e) => {
              // Collapse / remove buttons keep their own meaning.
              if ((e.target as HTMLElement).closest("button")) return;
              node.edit();
            }
      }
    >
      {(isRoot || isGroup) && (
        <button
          type="button"
          className="scene-object-collapse"
          onClick={(e) => {
            e.stopPropagation();
            node.toggle();
          }}
          title={node.isOpen ? "Collapse" : "Expand"}
        >
          {node.isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}
      {!isRoot && !isGroup && <span className="scene-item-icon scene-item-icon--spacer" />}
      {!isRoot && (
        <span className="scene-item-icon">
          {(() => {
            const Icon = isGroup ? GROUP_ICON : SHAPE_ICONS[data.shapeType ?? "sphere"];
            return <Icon size={14} />;
          })()}
        </span>
      )}
      {isEditing ? (
        <NodeRenameInput node={node} />
      ) : (
        <span className="scene-item-name">{data.name}</span>
      )}
      {data.mods && !isEditing && (
        <span className="scene-item-mods" title={`${data.mods} modifier${data.mods > 1 ? "s" : ""}`}>
          <Wand2 size={11} />
        </span>
      )}
      {data.color && !isEditing && (
        <span className="scene-item-color" style={{ background: data.color }} aria-hidden />
      )}
      {showOp && data.op && (
        <span className="scene-item-icon scene-item-icon--op" title={data.op}>
          <OpIcon op={data.op} />
        </span>
      )}
      {!preview && !isRoot && (
        <button
          type="button"
          className="scene-item-remove"
          title={isGroup ? "Remove object" : "Remove shape"}
          onClick={(e) => {
            e.stopPropagation();
            removeItem(containerId, data.id);
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

const SceneDropCursor = memo(function SceneDropCursor({ top, left, indent }: CursorProps) {
  return (
    <div
      className="scene-drop-cursor"
      style={{
        position: "absolute",
        pointerEvents: "none",
        top,
        left,
        right: indent,
      }}
    />
  );
});

/** Portal to body: panel transform/backdrop-filter break position:fixed for the default preview. */
function SceneDragPreview({ offset, id, isDragging }: DragPreviewProps) {
  const tree = useTreeApi<ArboristNode>();

  if (!isDragging || !offset || !id) return null;

  const node = tree.get(id);
  if (!node) return null;

  const previewWidth = typeof tree.width === "number" ? tree.width : 230;

  return createPortal(
    <div
      className="scene-drag-preview-layer"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        zIndex: 10000,
        pointerEvents: "none",
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        width: previewWidth,
      }}
    >
      <SceneNode
        preview
        node={node}
        tree={tree}
        style={{
          paddingLeft: node.level * tree.indent,
          opacity: 0.45,
          width: "100%",
        }}
      />
    </div>,
    document.body,
  );
}

/** Enter or click away saves, Escape cancels; an empty or unchanged name keeps the old one. */
function NodeRenameInput({ node }: { node: NodeRendererProps<ArboristNode>["node"] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape unmounts the input, which fires blur — don't let that blur save.
  const doneRef = useRef(false);

  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = inputRef.current?.value.trim() ?? "";
    if (save && name && name !== node.data.name) node.submit(name);
    else node.reset();
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="scene-item-rename-input"
      defaultValue={node.data.name}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key !== "Escape" && e.key !== "Enter") return;
        // Arborist's tree handler would see this Enter after a cancel and reopen the edit.
        e.stopPropagation();
        finish(e.key === "Enter");
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

export default function LeftPanel() {
  const listRef = useRef<HTMLDivElement>(null);
  const { height: listHeight, width: listWidth } = useElementSize(listRef);

  const root = useSceneStore((s) => s.root);
  const selectedItemId = useSceneStore((s) => s.selectedItemId);
  const selectedIds = useSceneStore((s) => s.selectedIds);
  const selectedContainerId = useSceneStore((s) => s.selectedContainerId);
  const rootSelected = useSceneStore((s) => s.rootSelected);
  const addGroupToContainer = useSceneStore((s) => s.addGroupToContainer);
  const moveItems = useSceneStore((s) => s.moveItems);
  const renameItem = useSceneStore((s) => s.renameItem);
  const updateRootName = useSceneStore((s) => s.updateRootName);
  const setSelection = useSceneStore((s) => s.setSelection);
  const selectRoot = useSceneStore((s) => s.selectRoot);
  const deselect = useSceneStore((s) => s.deselect);

  const treeRef = useRef<TreeApi<ArboristNode> | null>(null);
  /** True while we push store selection into the tree — its onSelect echo is ignored. */
  const syncingRef = useRef(false);
  /** False until the mounted tree got the store selection (skips its mount-time deselectAll). */
  const treeSyncedRef = useRef(false);
  const treeMounted = listHeight > 0 && listWidth > 0;

  // Store → tree. Arborist's `selection` prop is single-id and would collapse
  // a multi-selection, so sync through the tree api instead.
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) {
      treeSyncedRef.current = false;
      return;
    }
    const want = rootSelected ? [root.id] : selectedIds;
    const have = tree.selectedIds;
    if (want.length !== have.size || want.some((id) => !have.has(id))) {
      const active = rootSelected ? root.id : selectedItemId;
      syncingRef.current = true;
      tree.setSelection({ ids: want, anchor: active, mostRecent: active });
      syncingRef.current = false;
      if (active) tree.scrollTo(active);
    }
    treeSyncedRef.current = true;
  }, [treeMounted, selectedIds, selectedItemId, rootSelected, root.id]);

  const arboristData = useMemo(() => sceneRootToArborist(root), [root]);

  const container = findContainer(root, selectedContainerId);
  const groupExtra = container && container.items.length > 0 ? 1 : 0;
  const capExceeded = wouldExceedCap(root, groupExtra);
  const depthExceeded = wouldExceedDepth(root, selectedContainerId);

  function handleAddGroup() {
    if (depthExceeded) {
      showToast("Nesting too deep (max 16 levels)");
      return;
    }
    const ok = addGroupToContainer(selectedContainerId);
    if (!ok) {
      if (wouldExceedDepth(root, selectedContainerId)) {
        showToast("Nesting too deep (max 16 levels)");
      } else {
        showToast("Scene too complex (max 256 operations)");
      }
    }
  }

  // Tree → store.
  function syncSelection(nodes: NodeApi<ArboristNode>[]) {
    if (syncingRef.current || !treeSyncedRef.current) return;
    const ids = nodes.map((n) => n.id).filter((id) => id !== root.id);
    if (ids.length === 0) {
      if (nodes.length > 0) selectRoot();
      else deselect();
      return;
    }
    const recent = treeRef.current?.mostRecentNode?.id;
    setSelection(ids, recent && ids.includes(recent) ? recent : ids[ids.length - 1]);
    // The scene root is not part of a multi-selection.
    if (ids.length < nodes.length) treeRef.current?.deselect(root.id);
  }

  return (
    <div className="panel panel-left">
      <div className="panel-header">Objects</div>
      <div className="scene-list" ref={listRef}>
        {treeMounted && (
          <Tree<ArboristNode>
            ref={treeRef}
            data={arboristData}
            width={listWidth}
            height={listHeight}
            indent={TREE_INDENT}
            rowHeight={32}
            openByDefault
            dndRootElement={document.body}
            renderDragPreview={SceneDragPreview}
            renderCursor={SceneDropCursor}
            disableDrag={(data) => data.kind === "root"}
            idAccessor="id"
            childrenAccessor={arboristChildrenAccessor}
            onMove={({ dragIds, parentId, index }) => {
              moveItems(dragIds, parentId, index);
            }}
            onRename={({ id, name }) => {
              if (id === root.id) updateRootName(name);
              else renameItem(id, name);
            }}
            onSelect={syncSelection}
            disableDrop={({ parentNode, dragNodes }) => {
              const dragIds = dragNodes.map((n) => n.id);
              const parentData = parentNode.isRoot
                ? null
                : (parentNode.data as ArboristNode);
              return !canDropAt(
                root,
                dragIds,
                parentNode.isRoot ? null : parentNode.id,
                parentData,
                parentNode.isRoot,
              );
            }}
          >
            {SceneNode}
          </Tree>
        )}
      </div>
      <div className="scene-add-object">
        <button
          type="button"
          className="add-object-btn"
          onClick={handleAddGroup}
          disabled={capExceeded || depthExceeded}
          title={
            depthExceeded
              ? "Nesting too deep (max 16 levels)"
              : capExceeded
                ? "Scene too complex (max 256 operations)"
                : "Add nested object to selected container"
          }
        >
          <Plus size={13} /> Object
        </button>
      </div>
    </div>
  );
}
