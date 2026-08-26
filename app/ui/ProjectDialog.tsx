"use client";
/* eslint-disable jsx-a11y/no-static-element-interactions -- backdrop closes only on direct pointer activation */

import { useState } from "react";
import { DIRECTOR_INPUT_SCALING_OPTIONS } from "../../lib/types";
import type { ProjectOutputSettings } from "../../lib/project-contract";

export interface ProjectChoice {
  id: string;
  name: string;
  path?: string;
  updatedAt?: string;
}

interface Props {
  open: boolean;
  projects: ProjectChoice[];
  activeProjectId: string;
  activeProjectName: string;
  activeProjectPath?: string;
  settings: ProjectOutputSettings;
  onClose(): void;
  onSelect(id: string): void;
  onCreate(name: string): Promise<void>;
  legacyAssetCount?: number;
  onMigrate?(name: string): Promise<void>;
  onSettingsChange(patch: Partial<ProjectOutputSettings>): void;
}

export function ProjectDialog({ open, projects, activeProjectId, activeProjectName, activeProjectPath, settings, onClose, onSelect, onCreate, legacyAssetCount, onMigrate, onSettingsChange }: Props) {
  if (!open) return null;
  return <div className="modal-backdrop project-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && activeProjectId) onClose(); }}>
    <section className="settings-sheet project-sheet" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
      <div className="settings-head"><div><div><h2 id="project-dialog-title">projects</h2><p>durable libraries and shared output defaults</p></div></div><button onClick={onClose} disabled={!activeProjectId} aria-label="close projects">×</button></div>
      <div className="project-dialog-grid">
        <ProjectPicker projects={projects} activeProjectId={activeProjectId} onSelect={onSelect} onCreate={onCreate} legacyAssetCount={legacyAssetCount} onMigrate={onMigrate} />
        <section className="project-settings-pane">
          <div className="project-current"><span>current project</span><strong>{activeProjectName || "choose or create a project"}</strong>{activeProjectPath && <code>{activeProjectPath}</code>}</div>
          {activeProjectId ? <OutputSettings settings={settings} onChange={onSettingsChange} /> : <p className="empty-copy">A project owns its copied asset folder, metadata sidecars, draft job, and output defaults.</p>}
        </section>
      </div>
    </section>
  </div>;
}

function ProjectPicker({ projects, activeProjectId, onSelect, onCreate, legacyAssetCount, onMigrate }: Pick<Props, "projects" | "activeProjectId" | "onSelect" | "onCreate" | "legacyAssetCount" | "onMigrate">) {
  const [newName, setNewName] = useState("");
  async function create() {
    const name = newName.trim();
    if (!name) return;
    await onCreate(name);
    setNewName("");
  }
  async function migrate() {
    const name = newName.trim() || "imported workspace";
    await onMigrate?.(name);
    setNewName("");
  }
  return <aside className="project-picker">
    <span className="dialog-kicker">known projects</span>
    <div className="project-list">{projects.map((project) => <button key={project.id} className={project.id === activeProjectId ? "active" : ""} onClick={() => onSelect(project.id)}><strong>{project.name}</strong>{project.updatedAt && <span>{new Date(project.updatedAt).toLocaleString()}</span>}</button>)}{!projects.length && <p>no projects yet</p>}</div>
    <div className="new-project"><input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={64} placeholder="new project name" onKeyDown={(event) => { if (event.key === "Enter") void create(); }} /><button className="primary" onClick={() => void create()}>new project</button></div>
    {Boolean(legacyAssetCount && onMigrate) && <button className="secondary migrate-project" onClick={() => void migrate()}>migrate {legacyAssetCount} browser asset{legacyAssetCount === 1 ? "" : "s"}</button>}
    <small>letters, numbers, spaces, hyphens, and underscores only</small>
  </aside>;
}

function OutputSettings({ settings, onChange }: { settings: ProjectOutputSettings; onChange(patch: Partial<ProjectOutputSettings>): void }) {
  return <div className="project-output-settings">
    <div className="project-settings-head"><span>project output settings</span><div><button onClick={() => onChange({ width: 768, height: 1344 })}>portrait</button><button onClick={() => onChange({ width: 1344, height: 768 })}>landscape</button><button onClick={() => onChange({ width: 1024, height: 1024 })}>square</button></div></div>
    <div className="job-control-grid project-control-grid">
      <label><span>width</span><input type="number" min={64} max={8192} value={settings.width} onChange={(event) => onChange({ width: Number(event.target.value) })} /></label>
      <label><span>height</span><input type="number" min={64} max={8192} value={settings.height} onChange={(event) => onChange({ height: Number(event.target.value) })} /></label>
      <label><span>fps</span><input type="number" min={1} max={120} value={settings.fps} onChange={(event) => onChange({ fps: Number(event.target.value) })} /></label>
      <label><span>steps</span><input type="number" min={1} max={200} value={settings.steps} onChange={(event) => onChange({ steps: Number(event.target.value) })} /></label>
      <label className="wide"><span>sampler</span><input value={settings.sampler} onChange={(event) => onChange({ sampler: event.target.value })} /></label>
      <label><span>shift video</span><input type="number" step={0.1} value={settings.shiftVideo} onChange={(event) => onChange({ shiftVideo: Number(event.target.value) })} /></label>
      <label><span>shift audio</span><input type="number" step={0.1} value={settings.shiftAudio} onChange={(event) => onChange({ shiftAudio: Number(event.target.value) })} /></label>
      <label><span>reference image size</span><select value={settings.refImageSize} onChange={(event) => onChange({ refImageSize: event.target.value as ProjectOutputSettings["refImageSize"] })}><option value="match">match</option><option value="max">max</option></select></label>
      <label><span>input scaling</span><select value={settings.inputScaling} onChange={(event) => onChange({ inputScaling: event.target.value as ProjectOutputSettings["inputScaling"] })}>{DIRECTOR_INPUT_SCALING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="wide"><span>workflow</span><select value={settings.workflowPreset} onChange={(event) => onChange({ workflowPreset: event.target.value as ProjectOutputSettings["workflowPreset"] })}><option value="dasiwa-ref2va:v1">dasiwa-ref2va:v1</option></select></label>
      <label><span>container</span><select value={settings.outputContainer} onChange={(event) => onChange({ outputContainer: event.target.value })}><option>Auto</option><option>mp4</option><option>mov</option><option>mkv</option></select></label>
      <label><span>codec</span><select value={settings.outputCodec} onChange={(event) => onChange({ outputCodec: event.target.value })}><option>Auto</option><option>h264</option><option>hevc</option><option>prores</option></select></label>
      <label title="Video encoder CRF/CQ. Lower values preserve more quality and produce larger files."><span>video quality (CRF/CQ)</span><input type="number" min={0} max={51} value={settings.outputQuality} onChange={(event) => onChange({ outputQuality: Number(event.target.value) })} /></label>
      <label><span>audio codec</span><select value={settings.audioCodec} onChange={(event) => onChange({ audioCodec: event.target.value })}><option>Auto</option><option>aac</option><option>opus</option><option>pcm_s16le</option></select></label>
      <label className="wide"><span>audio bitrate</span><select value={settings.audioBitrate} onChange={(event) => onChange({ audioBitrate: event.target.value })}><option>96k</option><option>128k</option><option>192k</option><option>256k</option><option>320k</option></select></label>
    </div>
  </div>;
}
