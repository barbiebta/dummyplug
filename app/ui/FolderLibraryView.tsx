"use client";
/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- nested native buttons provide keyboard interaction; wrappers only dismiss/contextualize */
/* eslint-disable react/prop-types -- TypeScript Props are authoritative for the recursive renderer */

import { useMemo, useState } from "react";
import type { AssetRecord } from "../../lib/types";

interface FolderNode { name: string; path: string; folders: Map<string, FolderNode>; assets: AssetRecord[] }
interface Menu { x: number; y: number; asset?: AssetRecord; folder?: FolderNode }
interface Props {
  assets: AssetRecord[];
  folders: string[];
  selectedAssetId: string;
  onSelect(id: string): void;
  onToggle(id: string): void;
  onMove(asset: AssetRecord, folder: string): Promise<void>;
  onRename(asset: AssetRecord, name: string): Promise<void>;
  onTrash(asset: AssetRecord): Promise<void>;
  onCreateFolder(parent: string, name: string): Promise<void>;
  onRemoveFolder(path: string): Promise<void>;
  onMoveFolder(path: string, destination: string): Promise<void>;
  onRenameFolder(path: string, name: string): Promise<void>;
}

function treeOf(assets: AssetRecord[], folders: string[]) {
  const root: FolderNode = { name: "assets", path: "", folders: new Map(), assets: [] };
  for (const folderPath of folders) {
    let node = root;
    for (const part of folderPath.replaceAll("\\", "/").split("/").filter(Boolean)) {
      const path = node.path ? `${node.path}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path, folders: new Map(), assets: [] });
      node = node.folders.get(part)!;
    }
  }
  for (const asset of assets) {
    const parts = (asset.relativePath || asset.name).replaceAll("\\", "/").split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      const path = node.path ? `${node.path}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path, folders: new Map(), assets: [] });
      node = node.folders.get(part)!;
    }
    node.assets.push(asset);
  }
  return root;
}

export function FolderLibraryView(props: Props) {
  const root = useMemo(() => treeOf(props.assets, props.folders), [props.assets, props.folders]);
  const [menu, setMenu] = useState<Menu | null>(null);
  async function createFolder(parent: string) { const name = window.prompt("new folder name"); if (name?.trim()) await props.onCreateFolder(parent, name.trim()); setMenu(null); }
  async function move(asset: AssetRecord) { const folder = window.prompt("move to folder (blank for asset root)", (asset.relativePath || "").split("/").slice(0, -1).join("/")); if (folder != null) await props.onMove(asset, folder.trim()); setMenu(null); }
  async function rename(asset: AssetRecord) { const name = window.prompt("new asset filename", asset.name); if (name?.trim()) await props.onRename(asset, name.trim()); setMenu(null); }
  async function trash(asset: AssetRecord) { if (window.confirm(`move ${asset.name} to project trash?`)) await props.onTrash(asset); setMenu(null); }
  async function moveFolder(folder: FolderNode) { const destination = window.prompt("move folder into (blank for asset root)", ""); if (destination != null) await props.onMoveFolder(folder.path, destination.trim()); setMenu(null); }
  async function renameFolder(folder: FolderNode) { const name = window.prompt("new folder name", folder.name); if (name?.trim()) await props.onRenameFolder(folder.path, name.trim()); setMenu(null); }
  return <div className="folder-library" onClick={() => setMenu(null)}>
    <TreeNode node={root} depth={0} props={props} setMenu={setMenu} />
    {menu && <div className="asset-context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>{menu.asset ? <><button onClick={() => void move(menu.asset!)}>move to folder…</button><button onClick={() => void rename(menu.asset!)}>rename…</button><button onClick={() => void trash(menu.asset!)}>move to trash</button></> : <><button onClick={() => void createFolder(menu.folder?.path || "")}>new folder here…</button>{menu.folder?.path && <><button onClick={() => void moveFolder(menu.folder!)}>move folder…</button><button onClick={() => void renameFolder(menu.folder!)}>rename folder…</button><button onClick={() => { void props.onRemoveFolder(menu.folder!.path); setMenu(null); }}>remove empty folder</button></>}</>}</div>}
  </div>;
}

function TreeNode({ node, depth, props, setMenu }: { node: FolderNode; depth: number; props: Props; setMenu(menu: Menu): void }) {
  const body = <>{[...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((folder) => <TreeNode key={folder.path} node={folder} depth={depth + 1} props={props} setMenu={setMenu} />)}{node.assets.map((asset) => <div key={asset.id} className={`folder-asset ${props.selectedAssetId === asset.id ? "active" : ""}`} style={{ paddingLeft: 9 + depth * 14 }} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, asset }); }}><button className="folder-check" aria-pressed={asset.selected} onClick={() => props.onToggle(asset.id)}>{asset.selected ? "✓" : ""}</button><button className="folder-asset-name" onClick={() => props.onSelect(asset.id)}><span>{asset.kind === "audio" ? "♫" : asset.kind === "video" ? "▻" : "▧"}</span>{asset.name}</button></div>)}</>;
  if (depth === 0) return <div onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, folder: node }); }}>{body}</div>;
  return <details open className="folder-node"><summary style={{ paddingLeft: 4 + (depth - 1) * 14 }} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, folder: node }); }}>{node.name}</summary>{body}</details>;
}
