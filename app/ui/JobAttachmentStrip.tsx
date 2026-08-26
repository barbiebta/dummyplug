"use client";
/* eslint-disable @next/next/no-img-element -- project media streams are local bridge URLs */

import { useState } from "react";
import type { AssetRecord } from "../../lib/types";

interface Props {
  assets: AssetRecord[];
  onReorder(assetIds: string[]): void;
  onRemove(assetId: string): void;
  onOpen(assetId: string): void;
}

export function JobAttachmentStrip({ assets, onReorder, onRemove, onOpen }: Props) {
  const [draggedId, setDraggedId] = useState("");
  function move(id: string, destination: number) {
    const source = assets.findIndex((asset) => asset.id === id);
    if (source < 0 || destination < 0 || destination >= assets.length || source === destination) return;
    const ids = assets.map((asset) => asset.id);
    const [moved] = ids.splice(source, 1);
    ids.splice(destination, 0, moved);
    onReorder(ids);
  }
  return <section className="job-attachments" aria-label="ordered job attachments">
    <div className="job-attachments-head"><span>job attachments</span><em>drag to set H3 numbering</em></div>
    <div className="job-attachment-strip">{assets.map((asset, index) => <article
      className={`job-attachment ${draggedId === asset.id ? "dragging" : ""}`}
      draggable
      key={asset.id}
      onDragStart={(event) => { setDraggedId(asset.id); event.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => setDraggedId("")}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); if (draggedId) move(draggedId, index); setDraggedId(""); }}
    >
      <button className="attachment-preview" onClick={() => onOpen(asset.id)} aria-label={`edit ${asset.canonicalName || asset.name}`}>
        {asset.kind === "image" && asset.previewUrl ? <img src={asset.previewUrl} alt="" /> : asset.kind === "video" && asset.previewUrl ? <video src={asset.previewUrl} muted /> : <span>{asset.kind === "audio" ? "♫" : asset.kind.slice(0, 1)}</span>}
        <b>{index + 1}</b>
      </button>
      <strong title={asset.canonicalName || asset.name}>{asset.canonicalName || asset.name}</strong>
      <div><button disabled={index === 0} onClick={() => move(asset.id, index - 1)} aria-label={`move ${asset.name} earlier`}>←</button><button disabled={index === assets.length - 1} onClick={() => move(asset.id, index + 1)} aria-label={`move ${asset.name} later`}>→</button><button onClick={() => onRemove(asset.id)} aria-label={`remove ${asset.name} from job`}>×</button></div>
    </article>)}{!assets.length && <p>check assets in the library to add them here</p>}</div>
  </section>;
}
