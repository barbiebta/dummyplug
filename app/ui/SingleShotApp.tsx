"use client";
/* eslint-disable @next/next/no-img-element -- browser blob URLs are not compatible with the image optimizer */
/* eslint-disable jsx-a11y/media-has-caption -- imported visual and motion references do not include caption tracks */
/* eslint-disable jsx-a11y/no-static-element-interactions -- the modal backdrop only closes on direct backdrop clicks */

import { useEffect, useMemo, useRef, useState } from "react";
import { JobAttachmentStrip } from "./JobAttachmentStrip";
import { ProjectDialog } from "./ProjectDialog";
import { FolderLibraryView } from "./FolderLibraryView";
import { loadBrowserWorkspace, saveBrowserWorkspace, type PersistedDirectoryHandle, type PersistedFileHandle, type PersistedWorkspace } from "../../lib/browser-workspace";
import { DEFAULT_JOB_SETTINGS, normalizeJobSettings, randomSeed, sealJobZip, sha256Hex, validateJobSettings, validateVideoTrim } from "../../lib/job-bundle";
import { createJobId, DEFAULT_VERB_FAMILIES, deriveJobDesc, normalizeJobDesc } from "../../lib/job-identity";
import type { VerbFamily } from "../../lib/job-identity";
import { auditHotWords, parseHotWords } from "../../lib/hot-words";
import { resolveDeclaredIdentity, validateCharacterPolicy } from "../../lib/character-policy";
import { DEFAULT_PROJECT_OUTPUT_SETTINGS } from "../../lib/project-contract";
import type { ProjectAsset, ProjectManifest, ProjectOutputSettings } from "../../lib/project-contract";
import { createProject, createProjectFolder, importProjectAsset, listProjects, loadProject, moveProjectAsset, moveProjectFolder, projectAssetUrl, refreshProjectAssets, removeProjectFolder, renameProjectAsset, renameProjectFolder, saveProjectDraft, trashProjectAsset, updateProjectAsset, updateProjectSettings } from "../../lib/project-library-client";
import { makeReferenceSidecar, readReferenceSidecar, sidecarMatchKey, sidecarName } from "../../lib/reference-sidecar";
import { compileAttachments, enforceNonDiegeticMusicNA, hasNonDiegeticMusicNA, makeDemoAnalysis, validateSingleShotPrompt } from "../../lib/single-h3";
import { DEFAULT_PROMPT_TEMPLATES, EXPOSED_PROMPT_TEMPLATES, type PromptTemplateId, type PromptTemplateMap } from "../../lib/single-prompts";
import type { AssetAnalysis, AssetKind, AssetRecord, AssetRole, JobSettings, ModelSettings, PreparedReference, ReferenceUse } from "../../lib/types";

const DEFAULT_SETTINGS: ModelSettings = {
  provider: "openrouter",
  visionModel: "qwen/qwen3-vl-235b-a22b-instruct",
  promptModel: "google/gemini-3.7-flash",
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  rememberKey: false,
  temperature: 0.2,
  promptMaxTokens: 32_768,
};

const DEFAULT_LOCAL_SETTINGS: ModelSettings = {
  provider: "local",
  visionModel: "",
  promptModel: "",
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  rememberKey: false,
  temperature: 0.2,
  promptMaxTokens: 8_192,
};

const ROLE_OPTIONS: Array<{ value: AssetRole; label: string }> = [
  { value: "character", label: "character identity" },
  { value: "setting", label: "setting / landscape" },
  { value: "style", label: "visual style" },
  { value: "motion", label: "motion / camera" },
  { value: "prop", label: "prop / object" },
  { value: "audio", label: "audio" },
  { value: "general", label: "general reference" },
];

const REFERENCE_USE_OPTIONS: Record<AssetKind, Array<{ value: ReferenceUse; label: string }>> = {
  image: [
    { value: "subject", label: "Subject source · appearance / scene / style" },
    { value: "frame-anchor", label: "Picture entry · frame anchor / storyboard" },
  ],
  video: [
    { value: "subject", label: "Subject source · visible content / action" },
    { value: "video-structure", label: "Video entry · camera / pacing structure" },
    { value: "video-edit", label: "Video entry · direct edit source" },
    { value: "video-continuation", label: "Video entry · continuation source" },
  ],
  audio: [
    { value: "audio-reference", label: "Audio entry · reference signal" },
    { value: "audio-copy", label: "Audio entry · copy signal" },
  ],
};

function defaultReferenceUse(kind: AssetKind): ReferenceUse {
  return kind === "audio" ? "audio-reference" : "subject";
}

type FileHandleLike = PersistedFileHandle;
type DirectoryHandleLike = PersistedDirectoryHandle;
interface SaveFileHandleLike {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
interface FolderFile { file: File; relativePath: string; directory: DirectoryHandleLike; handle: FileHandleLike }

class ProviderRequestError extends Error {
  constructor(message: string, readonly payload: Record<string, unknown>) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

async function collectFolderFiles(directory: DirectoryHandleLike, prefix = ""): Promise<FolderFile[]> {
  const files: FolderFile[] = [];
  for await (const [name, handle] of directory.entries()) {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") files.push({ file: await handle.getFile(), relativePath, directory, handle });
    else files.push(...await collectFolderFiles(handle, relativePath));
  }
  return files;
}

function kindFor(file: File): AssetKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  const extension = file.name.toLocaleLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "tif", "tiff", "heic", "heif"].includes(extension)) return "image";
  if (["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpeg", "mpg", "ogv", "3gp"].includes(extension)) return "video";
  if (["wav", "mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "aiff", "aif", "wma"].includes(extension)) return "audio";
  return null;
}

function mimeFor(file: File, kind: AssetKind) {
  if (file.type) return file.type;
  const extension = file.name.toLocaleLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  const known: Record<string, string> = { mov: "video/quicktime", mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac" };
  return known[extension] || `${kind}/unknown`;
}

function humanBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

function projectAssetRecord(projectId: string, asset: ProjectAsset, selectedIds: Set<string>): AssetRecord {
  const source = asset.metadata || {};
  return {
    id: asset.id,
    name: asset.name,
    relativePath: asset.relativePath,
    importedAt: asset.importedAt,
    kind: asset.kind,
    size: asset.size,
    lastModified: asset.lastModified,
    mimeType: asset.mimeType,
    sourceWidth: asset.sourceWidth,
    sourceHeight: asset.sourceHeight,
    sourceDuration: asset.sourceDuration,
    sha256: asset.sha256,
    trimStart: asset.kind === "video" ? Number(source.trimStart ?? 0) : undefined,
    trimEnd: asset.kind === "video" ? Number(source.trimEnd ?? source.duration ?? 0) || undefined : undefined,
    previewUrl: projectAssetUrl(projectId, asset.relativePath),
    selected: selectedIds.has(asset.id),
    canonicalName: asset.canonicalName,
    declaredIdentity: asset.declaredIdentity || "",
    role: asset.role,
    referenceUse: asset.referenceUse,
    sourceOf: asset.sourceOf,
    note: asset.note,
    localSourceOf: asset.localSourceOf || "",
    localNote: asset.localNote || "",
    analysis: asset.analysis as AssetRecord["analysis"],
    localAnalysis: asset.localAnalysis as AssetRecord["localAnalysis"],
    missingFile: false,
  };
}

function verbVocabularyText(families: VerbFamily[]) {
  return families.map((family) => `${family.lemma}: ${family.forms.join(", ")}`).join("\n");
}

function parseVerbVocabulary(text: string) {
  return text.split(/\r?\n/).map((line) => {
    const [lemma, forms] = line.split(":", 2);
    const cleanLemma = lemma?.trim().toLocaleLowerCase();
    const cleanForms = forms?.split(",").map((form) => form.trim().toLocaleLowerCase()).filter(Boolean) || [];
    return cleanLemma && cleanForms.length ? { lemma: cleanLemma, forms: [...new Set(cleanForms)] } : null;
  }).filter((family): family is VerbFamily => Boolean(family) && family!.lemma !== "be");
}

function VisionRecord({ analysis, channel }: { analysis?: AssetAnalysis; channel: "strong" | "local" }) {
  if (!analysis) return <div className="vision-empty compact"><span>{channel} analysis not run</span><p>{channel === "local" ? "Local evidence stays separate and can record direct anatomical or NSFW detail." : "Strong evidence records precise visible identity, setting, style, and continuity detail."}</p></div>;
  return <div className={`vision-record vision-record-${channel}`}><div className="vision-head"><strong>{channel} vision record</strong><span>{analysis.analysisRole || "general"}</span></div><section><h3>summary</h3><p>{analysis.summary}</p></section><details open><summary>subjects</summary>{analysis.subjects.map((item) => <p key={item}>{item}</p>)}</details><details><summary>setting</summary><p>{analysis.setting}</p></details><details><summary>style</summary><p>{analysis.style}</p></details><details><summary>composition</summary><p>{analysis.composition}</p></details><details><summary>motion</summary><p>{analysis.motion}</p></details><details><summary>continuity locks</summary><ul>{analysis.continuityLocks.map((item) => <li key={item}>{item}</li>)}</ul></details></div>;
}

function ConnectionEditor({ channel, value, status, busy, onChange, onTest }: { channel: "strong" | "local"; value: ModelSettings; status: "unknown" | "connected" | "failed"; busy: boolean; onChange(value: ModelSettings): void; onTest(): void }) {
  const patch = (changes: Partial<ModelSettings>) => onChange({ ...value, ...changes });
  return <fieldset className={`connection-profile connection-profile-${channel}`}><legend><i className={`provider-dot ${status}`} aria-hidden="true" />{channel}</legend><p>{channel === "strong" ? "precise vision analysis and final prompt writing" : "a separate analysis channel for local or less-restricted tagging"}</p><label className="field"><span>provider</span><select value={value.provider} onChange={(event) => patch({ provider: event.target.value as ModelSettings["provider"] })}><option value="demo">offline demo</option><option value="openrouter">OpenRouter</option><option value="local">local OpenAI-compatible server</option></select></label>{value.provider === "local" && <label className="field"><span>server address</span><input value={value.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} /></label>}<label className="field"><span>vision model</span><input disabled={value.provider === "demo"} value={value.visionModel} onChange={(event) => patch({ visionModel: event.target.value })} placeholder={channel === "local" ? "local vision model id" : undefined} /></label>{channel === "strong" && <><label className="field"><span>prompt model</span><input disabled={value.provider === "demo"} value={value.promptModel} onChange={(event) => patch({ promptModel: event.target.value })} /></label><label className="field"><span>prompt output tokens</span><input type="number" min={8192} max={32768} step={4096} disabled={value.provider === "demo"} value={value.promptMaxTokens} onChange={(event) => patch({ promptMaxTokens: Math.max(8192, Math.min(32768, Number(event.target.value) || 32768)) })} /></label></>}{value.provider !== "demo" && <><label className="field"><span>api key</span><input type="password" value={value.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} autoComplete="off" /></label><label className="check-field"><input type="checkbox" checked={value.rememberKey} onChange={(event) => patch({ rememberKey: event.target.checked })} /><span>remember key in this browser profile</span></label></>}<label className="field"><span>temperature <output>{value.temperature.toFixed(1)}</output></span><input type="range" min="0" max="1" step="0.1" disabled={value.provider === "demo"} value={value.temperature} onChange={(event) => patch({ temperature: Number(event.target.value) })} /></label><button className="secondary connection-test" disabled={busy || (value.provider !== "demo" && !value.visionModel.trim())} onClick={onTest}>{busy ? `testing ${channel}…` : `test ${channel}`}</button></fieldset>;
}

function fileToDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function inspectSource(file: File, kind: AssetKind) {
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`Could not inspect ${file.name}.`));
        image.src = url;
      });
      return { sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight };
    }
    const media = document.createElement(kind === "video" ? "video" : "audio");
    media.preload = "metadata";
    media.src = url;
    await new Promise<void>((resolve, reject) => {
      media.onloadedmetadata = () => resolve();
      media.onerror = () => reject(new Error(`Could not inspect ${file.name}.`));
    });
    const video = kind === "video" ? media as HTMLVideoElement : null;
    return {
      ...(video ? { sourceWidth: video.videoWidth, sourceHeight: video.videoHeight } : {}),
      ...(Number.isFinite(media.duration) ? { sourceDuration: media.duration } : {}),
    };
  } finally { URL.revokeObjectURL(url); }
}

async function resizeImage(file: File, max = 1280) {
  const source = await fileToDataUrl(file);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Could not decode ${file.name}.`));
    image.src = source;
  });
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.84);
}

async function sampleVideo(file: File) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error(`Could not decode ${file.name}.`));
  });
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const times = duration > 0.5 ? [0.08, 0.5, 0.92].map((fraction) => Math.min(duration - 0.05, duration * fraction)) : [0];
  const frames: string[] = [];
  for (const time of times) {
    video.currentTime = Math.max(0, time);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      if (time === 0) resolve();
    });
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.8));
  }
  URL.revokeObjectURL(url);
  return frames;
}

export function SingleShotApp() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [simplePrompt, setSimplePrompt] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(10);
  const [jobSettings, setJobSettings] = useState<JobSettings>(DEFAULT_JOB_SETTINGS);
  const [generatedPrompt, setGeneratedPrompt] = useState("");
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [settings, setSettings] = useState<ModelSettings>(DEFAULT_SETTINGS);
  const [localSettings, setLocalSettings] = useState<ModelSettings>(DEFAULT_LOCAL_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"connection" | "prompts" | "naming" | "dirty-focus">("connection");
  const [promptOverrides, setPromptOverrides] = useState<Partial<PromptTemplateMap>>({});
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [busy, setBusy] = useState<"analyze-strong" | "analyze-local" | "generate" | "export" | "test-strong" | "test-local" | null>(null);
  const [message, setMessage] = useState("Choose a project, import assets, and assemble a job.");
  const [dragging, setDragging] = useState(false);
  const [assetFilterKind, setAssetFilterKind] = useState<"all" | AssetKind>("all");
  const [assetFilterText, setAssetFilterText] = useState("");
  const [sealFeedback, setSealFeedback] = useState("");
  const [providerStatus, setProviderStatus] = useState<"unknown" | "connected" | "failed">("unknown");
  const [localProviderStatus, setLocalProviderStatus] = useState<"unknown" | "connected" | "failed">("unknown");
  const [projects, setProjects] = useState<ProjectManifest[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectManifest | null>(null);
  const [draftReadyProjectId, setDraftReadyProjectId] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [attachmentOrder, setAttachmentOrder] = useState<string[]>([]);
  const [jobDesc, setJobDesc] = useState("");
  const [seedMode, setSeedMode] = useState<"fixed" | "random">("fixed");
  const [libraryView, setLibraryView] = useState<"list" | "folders">("list");
  const [libraryFolders, setLibraryFolders] = useState<string[]>([]);
  const [verbFamilies, setVerbFamilies] = useState(DEFAULT_VERB_FAMILIES);
  const [verbText, setVerbText] = useState(() => verbVocabularyText(DEFAULT_VERB_FAMILIES));
  const [hotWordText, setHotWordText] = useState("");
  const [requireNonDiegeticMusicNA, setRequireNonDiegeticMusicNA] = useState(true);
  const [legacyAssetCount, setLegacyAssetCount] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileStore = useRef(new Map<string, File>());
  const sourceHandleStore = useRef(new Map<string, FileHandleLike>());
  const sourceDirectoryStore = useRef(new Map<string, { directory: DirectoryHandleLike; sourceName: string }>());
  const metadataDirectoryStore = useRef<DirectoryHandleLike | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const providerProbeActive = useRef(false);
  const legacyWorkspaceStore = useRef<PersistedWorkspace | null>(null);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const rawSettings = localStorage.getItem("dummyplug.single.settings.v2");
      const rawLocalSettings = localStorage.getItem("dummyplug.single.localSettings.v1");
      const sessionKey = sessionStorage.getItem("dummyplug.single.v2.apiKey") || "";
      const localSessionKey = sessionStorage.getItem("dummyplug.single.v1.localApiKey") || "";
      const rawPrompts = localStorage.getItem("dummyplug.singlePromptOverrides.v2");
      setHotWordText(localStorage.getItem("dummyplug.hotWords.v1") || "");
      if (rawSettings) {
        try {
          const saved = JSON.parse(rawSettings) as Record<string, unknown>;
          setSettings({
            ...DEFAULT_SETTINGS,
            provider: (saved.provider || DEFAULT_SETTINGS.provider) as ModelSettings["provider"],
            visionModel: String(saved.visionModel || DEFAULT_SETTINGS.visionModel),
            promptModel: String(saved.promptModel || DEFAULT_SETTINGS.promptModel),
            baseUrl: String(saved.baseUrl || DEFAULT_SETTINGS.baseUrl),
            apiKey: saved.rememberKey ? String(saved.apiKey || "") : sessionKey,
            rememberKey: Boolean(saved.rememberKey),
            temperature: Number(saved.temperature ?? DEFAULT_SETTINGS.temperature),
            promptMaxTokens: Number(saved.promptMaxTokens || DEFAULT_SETTINGS.promptMaxTokens),
          });
        } catch { /* ignore stale settings */ }
      }
      if (rawLocalSettings) {
        try {
          const saved = JSON.parse(rawLocalSettings) as Record<string, unknown>;
          setLocalSettings({
            ...DEFAULT_LOCAL_SETTINGS,
            provider: (saved.provider || DEFAULT_LOCAL_SETTINGS.provider) as ModelSettings["provider"],
            visionModel: String(saved.visionModel ?? DEFAULT_LOCAL_SETTINGS.visionModel),
            promptModel: "",
            baseUrl: String(saved.baseUrl || DEFAULT_LOCAL_SETTINGS.baseUrl),
            apiKey: saved.rememberKey ? String(saved.apiKey || "") : localSessionKey,
            rememberKey: Boolean(saved.rememberKey),
            temperature: Number(saved.temperature ?? DEFAULT_LOCAL_SETTINGS.temperature),
            promptMaxTokens: 8_192,
          });
        } catch { /* ignore stale local settings */ }
      }
      if (rawPrompts) {
        try { setPromptOverrides(JSON.parse(rawPrompts) as Partial<PromptTemplateMap>); } catch { /* ignore stale prompt edits */ }
      }
      let saved: PersistedWorkspace | null = null;
      try { saved = await loadBrowserWorkspace(); } catch { /* private browser storage may be unavailable */ }
      if (!saved) {
        try { saved = JSON.parse(localStorage.getItem("dummyplug.single.v2.workspace.light") || "null") as PersistedWorkspace | null; } catch { /* ignore */ }
      }
      if (canceled) return;
      if (saved) {
        legacyWorkspaceStore.current = saved;
        setLegacyAssetCount(saved.assets.length);
        const directory = saved.metadataDirectory;
        if (directory) {
          metadataDirectoryStore.current = directory;
        }
        const restored: AssetRecord[] = [];
        for (const item of saved.assets) {
          const record = item.record;
          let file = item.file;
          if (item.sourceHandle) {
            sourceHandleStore.current.set(record.id, item.sourceHandle);
            try { file = await item.sourceHandle.getFile(); } catch { /* permission can be restored later */ }
          }
          if (item.sourceDirectory) sourceDirectoryStore.current.set(record.id, { directory: item.sourceDirectory, sourceName: file?.name || record.name });
          if (file) fileStore.current.set(record.id, file);
          const changed = Boolean(file && (file.size !== record.size || (record.lastModified != null && file.lastModified !== record.lastModified)));
          restored.push({
            ...record,
            name: file?.name || record.name,
            size: file?.size ?? record.size,
            lastModified: file?.lastModified ?? record.lastModified,
            mimeType: file?.type || record.mimeType,
            previewUrl: file ? URL.createObjectURL(file) : "",
            analysis: changed ? undefined : record.analysis,
            declaredIdentity: record.declaredIdentity || "",
            localSourceOf: record.localSourceOf || "",
            localNote: record.localNote || "",
            localAnalysis: changed ? undefined : record.localAnalysis,
            missingFile: !file,
          });
        }
        setAssets(restored);
        setSelectedAssetId(saved.selectedAssetId || restored[0]?.id || "");
        setSimplePrompt(saved.simplePrompt || "");
        setDurationSeconds(Math.max(1, Math.min(20, saved.durationSeconds || 10)));
        setJobSettings(normalizeJobSettings(saved.jobSettings));
        setGeneratedPrompt(saved.generatedPrompt || "");
        setPromptHistory((saved.promptHistory || []).filter(Boolean).slice(0, 5));
        setRequireNonDiegeticMusicNA(saved.requireNonDiegeticMusicNA !== false);
        if (restored.length) setMessage(`Restored ${restored.length} asset${restored.length === 1 ? "" : "s"} from the new single-shot workspace.`);
      }
      setStorageReady(true);
    })();
    return () => { canceled = true; };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    const stored = { ...settings, apiKey: settings.rememberKey ? settings.apiKey : "" };
    localStorage.setItem("dummyplug.single.settings.v2", JSON.stringify(stored));
    if (settings.rememberKey) sessionStorage.removeItem("dummyplug.single.v2.apiKey");
    else sessionStorage.setItem("dummyplug.single.v2.apiKey", settings.apiKey);
  }, [settings, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    const stored = { ...localSettings, apiKey: localSettings.rememberKey ? localSettings.apiKey : "" };
    localStorage.setItem("dummyplug.single.localSettings.v1", JSON.stringify(stored));
    if (localSettings.rememberKey) sessionStorage.removeItem("dummyplug.single.v1.localApiKey");
    else sessionStorage.setItem("dummyplug.single.v1.localApiKey", localSettings.apiKey);
  }, [localSettings, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    if (Object.keys(promptOverrides).length) localStorage.setItem("dummyplug.singlePromptOverrides.v2", JSON.stringify(promptOverrides));
    else localStorage.removeItem("dummyplug.singlePromptOverrides.v2");
  }, [promptOverrides, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    if (hotWordText) localStorage.setItem("dummyplug.hotWords.v1", hotWordText);
    else localStorage.removeItem("dummyplug.hotWords.v1");
  }, [hotWordText, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    let canceled = false;
    void (async () => {
      try {
        const result = await listProjects();
        if (canceled) return;
        setProjects(result.projects);
        setProjectRoot(result.root);
        const lastProjectId = localStorage.getItem("dummyplug.lastProjectId") || "";
        const initial = result.projects.find((project) => project.id === lastProjectId) || result.projects[0];
        if (initial) await openProject(initial.id);
        else { setProjectDialogOpen(true); setMessage("Create a project or migrate the restored browser workspace."); }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not open the project library.");
        setProjectDialogOpen(true);
      }
      const rawVerbs = localStorage.getItem("dummyplug.verbFamilies.v1");
      if (rawVerbs) try { const parsed = JSON.parse(rawVerbs) as VerbFamily[]; setVerbFamilies(parsed); setVerbText(verbVocabularyText(parsed)); } catch { /* retain defaults */ }
    })();
    return () => { canceled = true; };
  }, [storageReady]);

  useEffect(() => {
    const timer = window.setTimeout(() => setProviderStatus(settings.provider === "demo" ? "connected" : "unknown"), 0);
    return () => window.clearTimeout(timer);
  }, [settings.apiKey, settings.baseUrl, settings.provider, settings.promptModel, settings.visionModel]);

  useEffect(() => {
    const timer = window.setTimeout(() => setLocalProviderStatus(localSettings.provider === "demo" ? "connected" : "unknown"), 0);
    return () => window.clearTimeout(timer);
  }, [localSettings.apiKey, localSettings.baseUrl, localSettings.provider, localSettings.visionModel]);

  useEffect(() => {
    if (!storageReady) return;
    const probe = () => { if (document.visibilityState === "visible") void (async () => { await testProvider("strong", true); await testProvider("local", true); })(); };
    window.addEventListener("focus", probe);
    document.addEventListener("visibilitychange", probe);
    const timer = window.setTimeout(probe, 600);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", probe); document.removeEventListener("visibilitychange", probe); };
  // Connection inputs intentionally re-register the focus probe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSettings.apiKey, localSettings.baseUrl, localSettings.provider, settings.apiKey, settings.baseUrl, settings.provider, storageReady]);

  useEffect(() => {
    if (!storageReady || activeProject) return;
    const timer = window.setTimeout(() => {
      const persisted: PersistedWorkspace = {
        version: 2,
        assets: assets.map((asset) => {
          const record = Object.fromEntries(Object.entries(asset).filter(([key]) => key !== "previewUrl")) as Omit<AssetRecord, "previewUrl">;
          const sourceHandle = sourceHandleStore.current.get(asset.id);
          return { record, file: sourceHandle ? undefined : fileStore.current.get(asset.id), sourceHandle, sourceDirectory: sourceDirectoryStore.current.get(asset.id)?.directory };
        }),
        metadataDirectory: metadataDirectoryStore.current || undefined,
        selectedAssetId,
        simplePrompt,
        durationSeconds,
        generatedPrompt,
        promptHistory,
        jobSettings,
        requireNonDiegeticMusicNA,
      };
      const light: PersistedWorkspace = { ...persisted, metadataDirectory: undefined, assets: persisted.assets.map(({ record }) => ({ record })) };
      try { localStorage.setItem("dummyplug.single.v2.workspace.light", JSON.stringify(light)); } catch { /* IndexedDB is primary */ }
      void saveBrowserWorkspace(persisted).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [activeProject, assets, durationSeconds, generatedPrompt, jobSettings, promptHistory, requireNonDiegeticMusicNA, selectedAssetId, simplePrompt, storageReady]);

  useEffect(() => {
    if (!activeProject || draftReadyProjectId !== activeProject.id) return;
    const timer = window.setTimeout(() => {
      void saveProjectDraft(activeProject.id, {
        simplePrompt,
        jobDesc,
        selectedAssetIds: attachmentOrder,
        duration: durationSeconds,
        seedMode,
        fixedSeed: jobSettings.seed,
        generatedPrompt,
        generatedPromptHistory: promptHistory,
        requireNonDiegeticMusicNA,
      }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not save the project draft."));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeProject, attachmentOrder, draftReadyProjectId, durationSeconds, generatedPrompt, jobDesc, jobSettings.seed, promptHistory, requireNonDiegeticMusicNA, seedMode, simplePrompt]);

  async function openProject(projectId: string) {
    setDraftReadyProjectId("");
    const loaded = await loadProject(projectId);
    const selectedIds = new Set(loaded.draft.selectedAssetIds);
    const records = loaded.assets.map((asset) => projectAssetRecord(projectId, asset, selectedIds));
    fileStore.current.clear();
    sourceHandleStore.current.clear();
    sourceDirectoryStore.current.clear();
    metadataDirectoryStore.current = null;
    setActiveProject(loaded.project);
    setProjectRoot(loaded.root);
    setAssets(records);
    setLibraryFolders(loaded.folders);
    setAttachmentOrder(loaded.draft.selectedAssetIds.filter((id) => records.some((asset) => asset.id === id)));
    setSelectedAssetId(records[0]?.id || "");
    setSimplePrompt(loaded.draft.simplePrompt);
    setJobDesc(loaded.draft.jobDesc);
    setDurationSeconds(Math.max(1, Math.min(20, loaded.draft.duration || 5)));
    setSeedMode(loaded.draft.seedMode);
    setJobSettings({ ...DEFAULT_JOB_SETTINGS, ...loaded.project.outputSettings, title: loaded.project.name, seed: loaded.draft.fixedSeed });
    setGeneratedPrompt(loaded.draft.generatedPrompt);
    setPromptHistory(loaded.draft.generatedPromptHistory.slice(0, 5));
    setRequireNonDiegeticMusicNA(loaded.draft.requireNonDiegeticMusicNA !== false);
    localStorage.setItem("dummyplug.lastProjectId", loaded.project.id);
    setProjectDialogOpen(false);
    setMessage(`Opened ${loaded.project.name}; ${records.length} managed asset${records.length === 1 ? "" : "s"} ready.`);
    window.requestAnimationFrame(() => setDraftReadyProjectId(loaded.project.id));
  }

  async function createAndOpenProject(name: string) {
    try {
      const created = await createProject(name);
      setProjects((current) => [created.project, ...current]);
      setProjectRoot(created.root);
      await openProject(created.project.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create the project."); }
  }

  async function migrateLegacyWorkspace(name: string) {
    const legacy = legacyWorkspaceStore.current;
    if (!legacy?.assets.length) return;
    try {
      const created = await createProject(name);
      setMessage(`Copying ${legacy.assets.length} legacy asset${legacy.assets.length === 1 ? "" : "s"} into ${created.project.name}…`);
      for (const item of legacy.assets) {
        let file = item.file;
        if (!file && item.sourceHandle) try { file = await item.sourceHandle.getFile(); } catch { /* report missing below */ }
        if (!file) throw new Error(`${item.record.name}: the legacy source could not be reopened.`);
        const record = { ...item.record, previewUrl: "" } as AssetRecord;
        const sidecar = makeReferenceSidecar({ ...record, localSourceOf: record.localSourceOf || "", localNote: record.localNote || "" }, { strong: settings, local: localSettings }, new Date().toISOString(), { relativePath: item.record.name, importedAt: item.record.importedAt });
        await importProjectAsset(created.project.id, file, item.record.name, JSON.stringify(sidecar));
      }
      setProjects((current) => [created.project, ...current]);
      await openProject(created.project.id);
      setLegacyAssetCount(0);
      setMessage(`Migrated ${legacy.assets.length} legacy asset${legacy.assets.length === 1 ? "" : "s"}. The old browser workspace remains untouched as a fallback.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not migrate the legacy workspace."); }
  }

  async function patchProjectOutputSettings(patch: Partial<ProjectOutputSettings>) {
    if (!activeProject) return;
    const optimistic = { ...activeProject.outputSettings, ...patch };
    setActiveProject({ ...activeProject, outputSettings: optimistic });
    setJobSettings((current) => ({ ...current, ...patch }));
    try {
      const result = await updateProjectSettings(activeProject.id, patch);
      setActiveProject(result.project);
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save project settings."); }
  }

  async function recrawlProject() {
    if (!activeProject) return;
    try {
      const refreshed = await refreshProjectAssets(activeProject.id);
      const discovered = refreshed.assets;
      const selectedIds = new Set(attachmentOrder);
      const records = discovered.map((asset) => projectAssetRecord(activeProject.id, asset, selectedIds));
      setAssets(records);
      setLibraryFolders(refreshed.folders || []);
      setAttachmentOrder((current) => current.filter((id) => records.some((asset) => asset.id === id)));
      setMessage(`Refreshed ${activeProject.name}; ${records.length} asset${records.length === 1 ? "" : "s"} found.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not refresh the project library."); }
  }

  async function organizeAsset(action: "move" | "rename", asset: AssetRecord, value: string) {
    if (!activeProject || !asset.relativePath) return;
    try {
      if (action === "move") await moveProjectAsset(activeProject.id, asset.relativePath, value);
      else await renameProjectAsset(activeProject.id, asset.relativePath, value);
      await recrawlProject();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not organize the project asset."); }
  }

  async function createLibraryFolder(parent: string, name: string) {
    if (!activeProject) return;
    try { await createProjectFolder(activeProject.id, parent ? `${parent}/${name}` : name); await recrawlProject(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not create the folder."); }
  }

  async function removeLibraryFolder(path: string) {
    if (!activeProject) return;
    try { await removeProjectFolder(activeProject.id, path); await recrawlProject(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Only empty folders can be removed."); }
  }

  async function organizeFolder(action: "move" | "rename", path: string, value: string) {
    if (!activeProject) return;
    try {
      if (action === "move") await moveProjectFolder(activeProject.id, path, value);
      else await renameProjectFolder(activeProject.id, path, value);
      await recrawlProject();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not organize the folder."); }
  }

  async function ensureAssetFile(asset: AssetRecord) {
    const cached = fileStore.current.get(asset.id);
    if (cached) return cached;
    if (!activeProject || !asset.relativePath) throw new Error(`${asset.name}: project source is unavailable.`);
    const response = await fetch(projectAssetUrl(activeProject.id, asset.relativePath));
    if (!response.ok) throw new Error(`${asset.name}: could not load the managed source.`);
    const file = new File([await response.blob()], asset.name, { type: asset.mimeType, lastModified: asset.lastModified });
    fileStore.current.set(asset.id, file);
    return file;
  }

  async function hydrateAssetSource(asset: AssetRecord) {
    if (!activeProject || !asset.relativePath || asset.kind === "audio" || (asset.kind === "image" ? asset.sourceWidth != null : asset.sourceDuration != null)) return;
    try {
      const inspected = await inspectSource(await ensureAssetFile(asset), asset.kind);
      const patch: Partial<AssetRecord> = { ...inspected };
      if (asset.kind === "video" && inspected.sourceDuration != null && asset.trimEnd == null) { patch.trimStart = 0; patch.trimEnd = inspected.sourceDuration; }
      patchAsset(asset.id, patch);
      await updateProjectAsset(activeProject.id, asset.relativePath, { sourceFacts: { width: inspected.sourceWidth, height: inspected.sourceHeight, duration: inspected.sourceDuration }, ...(asset.kind === "video" ? { metadata: { trimStart: patch.trimStart ?? asset.trimStart, trimEnd: patch.trimEnd ?? asset.trimEnd } } : {}) });
    } catch { /* unsupported codecs remain usable for packaging and manual metadata */ }
  }

  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) || assets[0];
  const chosenAssets = attachmentOrder.map((id) => assets.find((asset) => asset.id === id)).filter((asset): asset is AssetRecord => Boolean(asset));
  // Source inspection is deliberately lazy for externally added assets.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedAsset) void hydrateAssetSource(selectedAsset); }, [selectedAsset?.id, selectedAsset?.sourceDuration, selectedAsset?.sourceWidth]);
  const compiled = useMemo(() => compileAttachments(chosenAssets), [chosenAssets]);
  const validation = generatedPrompt ? validateSingleShotPrompt(generatedPrompt, compiled.attachments, compiled.subjects) : null;
  const characterValidation = generatedPrompt ? validateCharacterPolicy(generatedPrompt, compiled.subjects, jobSettings.characterPolicy) : null;
  const analyzedCount = assets.filter((asset) => asset.analysis || asset.localAnalysis).length;
  const resolvedJobDescPreview = deriveJobDesc(simplePrompt, chosenAssets, jobDesc, verbFamilies);
  const hotWords = useMemo(() => parseHotWords(hotWordText), [hotWordText]);
  const hotWordAudit = useMemo(() => auditHotWords(hotWords, simplePrompt, chosenAssets, generatedPrompt), [chosenAssets, generatedPrompt, hotWords, simplePrompt]);
  const visibleAssets = assets.filter((asset) => {
    if (assetFilterKind !== "all" && asset.kind !== assetFilterKind) return false;
    const query = assetFilterText.trim().toLocaleLowerCase();
    if (!query) return true;
    return [asset.name, asset.canonicalName, asset.declaredIdentity, asset.role, asset.referenceUse, asset.sourceOf, asset.note, asset.localSourceOf, asset.localNote, asset.analysis ? JSON.stringify(asset.analysis) : "", asset.localAnalysis ? JSON.stringify(asset.localAnalysis) : ""].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
  });
  const sealIssues = [
    ...(!generatedPrompt.trim() ? ["Write or generate the six-part prompt."] : validation && !validation.valid ? ["The six-part prompt does not validate against the current selected references."] : []),
    ...(characterValidation && !characterValidation.valid ? [characterValidation.forbiddenVocabulary.length ? `Final prompt uses disallowed character vocabulary: ${characterValidation.forbiddenVocabulary.flatMap((item) => item.terms).join(", ")}.` : `Cast lock identity is missing from ${characterValidation.missingCastIdentity.join(", ")}.`] : []),
    ...(requireNonDiegeticMusicNA && generatedPrompt.trim() && !hasNonDiegeticMusicNA(generatedPrompt) ? ["non_diegetic_music must be N/A while the checkbox is on."] : []),
    ...compiled.warnings,
    ...validateJobSettings(jobSettings, durationSeconds),
    ...chosenAssets.map(validateVideoTrim).filter((issue): issue is string => Boolean(issue)),
    ...chosenAssets.filter((asset) => asset.missingFile).map((asset) => `${asset.name}: reload the source file.`),
  ];

  async function postProvider(body: Record<string, unknown>, channel: "strong" | "local" = "strong") {
    const connection = channel === "local" ? localSettings : settings;
    const setConnectionStatus = channel === "local" ? setLocalProviderStatus : setProviderStatus;
    if (connection.provider === "openrouter" && !connection.apiKey.trim()) {
      throw new ProviderRequestError(`Open settings and enter the ${channel} OpenRouter API key.`, {});
    }
    if (body.action === "expand-single" ? !connection.promptModel.trim() : !connection.visionModel.trim()) throw new ProviderRequestError(`Choose the ${channel} ${body.action === "expand-single" ? "prompt" : "vision"} model in settings.`, {});
    const controller = new AbortController();
    activeController.current = controller;
    const endpoint = connection.provider === "demo" ? "/api/provider" : "/provider-bridge";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, settings: connection, ...(Object.keys(promptOverrides).length ? { promptTemplates: promptOverrides } : {}) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(text) as Record<string, unknown>; }
      catch { payload = { error: text.trim().slice(0, 700) || `Provider returned ${response.status} without JSON.` }; }
      if (!response.ok) throw new ProviderRequestError(String(payload.error || "Provider request failed."), payload);
      setConnectionStatus("connected");
      return payload;
    } catch (error) {
      setConnectionStatus("failed");
      if (controller.signal.aborted) throw new ProviderRequestError("Request canceled.", { canceled: true });
      throw error;
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  }

  async function requestDirectoryAccess(directory: DirectoryHandleLike) {
    try {
      if (!directory.queryPermission || await directory.queryPermission({ mode: "readwrite" }) === "granted") return true;
      return Boolean(directory.requestPermission && await directory.requestPermission({ mode: "readwrite" }) === "granted");
    } catch { return false; }
  }

  async function writeAssetSidecar(asset: AssetRecord, directory?: DirectoryHandleLike) {
    const binding = sourceDirectoryStore.current.get(asset.id);
    const destination = directory || binding?.directory || metadataDirectoryStore.current;
    if (!destination) return false;
    if (!await requestDirectoryAccess(destination)) return false;
    const sidecar = makeReferenceSidecar(asset, { strong: settings, local: localSettings });
    if (!sidecar) return false;
    const handle = await destination.getFileHandle(sidecarName(binding?.sourceName || asset.name), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(sidecar, null, 2));
    await writable.close();
    return true;
  }

  async function readCachedSidecar(directory: DirectoryHandleLike, file: File, assetId: string) {
    try {
      const handle = await directory.getFileHandle(sidecarName(file.name), { create: false });
      const imported = readReferenceSidecar(await (await handle.getFile()).text(), assetId);
      if (!imported) return null;
      if (imported.source && (imported.source.name !== file.name || imported.source.size !== file.size)) return null;
      return imported;
    } catch { return null; }
  }

  async function addFiles(files: FileList | File[], relativePaths = new Map<File, string>(), directories = new Map<File, DirectoryHandleLike>(), handles = new Map<File, FileHandleLike>()) {
    const incoming = [...files];
    const sidecars = new Map<string, File>();
    for (const file of incoming) if (file.type === "application/json" || file.name.toLocaleLowerCase().endsWith(".json")) sidecars.set(sidecarMatchKey(relativePaths.get(file) || file.webkitRelativePath || file.name), file);
    if (activeProject) {
      const media = incoming.filter((file) => kindFor(file));
      if (!media.length) return setMessage("No supported image, video, or audio assets were found.");
      setMessage(`Importing ${media.length} asset${media.length === 1 ? "" : "s"} into ${activeProject.name}…`);
      try {
        for (const file of media) {
          const relativePath = relativePaths.get(file) || file.webkitRelativePath || file.name;
          const companion = sidecars.get(sidecarMatchKey(relativePath));
          const imported = await importProjectAsset(activeProject.id, file, relativePath, companion ? await companion.text() : undefined);
          const kind = kindFor(file)!;
          try {
            const inspected = await inspectSource(file, kind);
            await updateProjectAsset(activeProject.id, imported.relativePath, {
              sourceFacts: { width: inspected.sourceWidth, height: inspected.sourceHeight, duration: inspected.sourceDuration },
              ...(kind === "video" ? { metadata: { trimStart: 0, trimEnd: inspected.sourceDuration } } : {}),
            });
          } catch { /* retain imported source even when the browser cannot decode its codec */ }
        }
        await recrawlProject();
        setMessage(`Imported ${media.length} asset${media.length === 1 ? "" : "s"} into ${activeProject.name}.`);
      } catch (error) { setMessage(error instanceof Error ? error.message : "Could not import assets into the project."); }
      return;
    }
    const records: AssetRecord[] = [];
    const unsupported: string[] = [];
    let importedCount = 0;
    for (const file of incoming) {
      const kind = kindFor(file);
      if (!kind) {
        if (!file.name.toLocaleLowerCase().endsWith(".json")) unsupported.push(file.name);
        continue;
      }
      const reusable = assets.find((asset) => asset.name === file.name && asset.kind === kind && asset.missingFile);
      const id = reusable?.id || `asset-${crypto.randomUUID().slice(0, 8)}`;
      const changed = Boolean(reusable && (reusable.size !== file.size || (reusable.lastModified != null && reusable.lastModified !== file.lastModified)));
      fileStore.current.set(id, file);
      const handle = handles.get(file);
      if (handle) sourceHandleStore.current.set(id, handle);
      const directory = directories.get(file);
      if (directory) sourceDirectoryStore.current.set(id, { directory, sourceName: file.name });
      const relativePath = relativePaths.get(file) || file.webkitRelativePath || file.name;
      const sidecarFile = sidecars.get(sidecarMatchKey(relativePath));
      const imported = sidecarFile ? readReferenceSidecar(await sidecarFile.text(), id) : metadataDirectoryStore.current ? await readCachedSidecar(metadataDirectoryStore.current, file, id) : null;
      if (imported) importedCount += 1;
      let sourceMetadata: Pick<AssetRecord, "sourceWidth" | "sourceHeight" | "sourceDuration"> = {};
      try { sourceMetadata = await inspectSource(file, kind); } catch { /* retain asset even when Chrome cannot decode its codec */ }
      records.push({
        ...(reusable || {}),
        id,
        name: file.name,
        kind,
        size: file.size,
        lastModified: file.lastModified,
        mimeType: mimeFor(file, kind),
        ...sourceMetadata,
        trimStart: kind === "video" ? reusable?.trimStart ?? 0 : undefined,
        trimEnd: kind === "video" ? reusable?.trimEnd ?? sourceMetadata.sourceDuration : undefined,
        previewUrl: URL.createObjectURL(file),
        selected: reusable?.selected ?? false,
        canonicalName: imported?.canonicalName ?? reusable?.canonicalName ?? "",
        declaredIdentity: imported?.declaredIdentity ?? reusable?.declaredIdentity ?? "",
        role: imported?.role ?? reusable?.role ?? (kind === "audio" ? "audio" : "general"),
        referenceUse: imported?.referenceUse ?? reusable?.referenceUse ?? defaultReferenceUse(kind),
        sourceOf: imported?.sourceOf ?? reusable?.sourceOf ?? "",
        note: imported?.note ?? reusable?.note ?? "",
        localSourceOf: imported?.localSourceOf ?? reusable?.localSourceOf ?? "",
        localNote: imported?.localNote ?? reusable?.localNote ?? "",
        analysis: imported?.analysis ?? (changed ? undefined : reusable?.analysis),
        localAnalysis: imported?.localAnalysis ?? (changed ? undefined : reusable?.localAnalysis),
        missingFile: false,
      });
    }
    setAssets((current) => {
      const replacements = new Map(records.map((record) => [record.id, record]));
      const existingIds = new Set(current.map((asset) => asset.id));
      return [...current.map((asset) => replacements.get(asset.id) || asset), ...records.filter((record) => !existingIds.has(record.id))];
    });
    if (!selectedAssetId && records[0]) setSelectedAssetId(records[0].id);
    if (records.length) setMessage(`${records.length} asset${records.length === 1 ? "" : "s"} added${importedCount ? `; ${importedCount} matching metadata file${importedCount === 1 ? "" : "s"} loaded` : ""}${unsupported.length ? `; skipped unsupported: ${unsupported.slice(0, 3).join(", ")}${unsupported.length > 3 ? ` +${unsupported.length - 3} more` : ""}` : ""}.`);
    else if (unsupported.length) setMessage(`No supported assets found. Skipped: ${unsupported.slice(0, 3).join(", ")}${unsupported.length > 3 ? ` +${unsupported.length - 3} more` : ""}.`);
  }

  async function pickReferenceFiles() {
    const picker = (window as Window & { showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FileHandleLike[]> }).showOpenFilePicker;
    if (!picker) return fileInputRef.current?.click();
    try {
      const handles = await picker({ multiple: true });
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      await addFiles(files, new Map(), new Map(), new Map(files.map((file, index) => [file, handles[index]])));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(error instanceof Error ? error.message : "Could not add assets.");
    }
  }

  async function pickReferenceFolder() {
    const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandleLike> }).showDirectoryPicker;
    if (!picker) return setMessage("Folder access is not available in this browser. Select media and matching JSON files together instead.");
    try {
      const root = await picker({ mode: "readwrite" });
      const entries = await collectFolderFiles(root);
      await addFiles(entries.map((entry) => entry.file), new Map(entries.map((entry) => [entry.file, entry.relativePath])), new Map(entries.map((entry) => [entry.file, entry.directory])), new Map(entries.map((entry) => [entry.file, entry.handle])));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(error instanceof Error ? error.message : "Could not add folder.");
    }
  }

  function patchAsset(id: string, patch: Partial<AssetRecord>) {
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, ...patch } : asset));
  }

  function toggleJobAsset(id: string) {
    const included = attachmentOrder.includes(id);
    setAttachmentOrder((current) => included ? current.filter((assetId) => assetId !== id) : [...current, id]);
    patchAsset(id, { selected: !included });
    if (!included) { const asset = assets.find((candidate) => candidate.id === id); if (asset) void hydrateAssetSource(asset); }
  }

  function reorderJobAssets(ids: string[]) {
    setAttachmentOrder(ids);
  }

  function patchJobSettings(patch: Partial<JobSettings>) {
    setJobSettings((current) => ({ ...current, ...patch }));
  }

  async function saveSelectedMetadata() {
    const current = assets.find((asset) => asset.id === selectedAssetId);
    if (!current) return;
    try {
      if (activeProject && current.relativePath) {
        await updateProjectAsset(activeProject.id, current.relativePath, { metadata: { canonicalName: current.canonicalName, declaredIdentity: current.declaredIdentity, role: current.role, referenceUse: current.referenceUse, sourceOf: current.sourceOf, note: current.note, localSourceOf: current.localSourceOf, localNote: current.localNote, trimStart: current.trimStart, trimEnd: current.trimEnd, width: current.sourceWidth, height: current.sourceHeight, duration: current.sourceDuration } });
        setMessage(`${sidecarName(current.name)} saved in ${activeProject.name}.`);
        return;
      }
      if (await writeAssetSidecar(current)) setMessage(`${sidecarName(current.name)} saved.`);
      else setMessage("Metadata is saved in the browser. Load a folder or choose a metadata folder to write the adjacent JSON file.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save metadata JSON."); }
  }

  function downloadSidecar(asset: AssetRecord) {
    const sidecar = makeReferenceSidecar(asset, { strong: settings, local: localSettings });
    if (!sidecar) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(sidecar, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = sidecarName(asset.name);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function removeAsset(id: string) {
    const target = assets.find((asset) => asset.id === id);
    if (activeProject && target?.relativePath) {
      try {
        await trashProjectAsset(activeProject.id, target.relativePath);
        setAttachmentOrder((current) => current.filter((assetId) => assetId !== id));
        await recrawlProject();
        if (selectedAssetId === id) setSelectedAssetId(assets.find((asset) => asset.id !== id)?.id || "");
        setMessage(`${target.name} moved to the project trash.`);
      } catch (error) { setMessage(error instanceof Error ? error.message : "Could not move the asset to trash."); }
      return;
    }
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    fileStore.current.delete(id);
    sourceHandleStore.current.delete(id);
    sourceDirectoryStore.current.delete(id);
    setAssets((current) => current.filter((asset) => asset.id !== id));
    setAttachmentOrder((current) => current.filter((assetId) => assetId !== id));
    if (selectedAssetId === id) setSelectedAssetId(assets.find((asset) => asset.id !== id)?.id || "");
  }

  async function analyzeSelected(channel: "strong" | "local" = "strong") {
    if (!selectedAsset) return setMessage("Select an asset first.");
    const connection = channel === "local" ? localSettings : settings;
    setBusy(channel === "local" ? "analyze-local" : "analyze-strong");
    setMessage(`${channel === "local" ? "Locally analyzing" : "Analyzing"} ${selectedAsset.name} as ${selectedAsset.role}…`);
    try {
      const file = await ensureAssetFile(selectedAsset);
      let analysis: AssetRecord["analysis"];
      if (connection.provider === "demo") analysis = { ...makeDemoAnalysis(channel === "local" ? { ...selectedAsset, sourceOf: selectedAsset.localSourceOf || "", note: selectedAsset.localNote || "" } : selectedAsset), channel };
      else {
        const dataUrls = selectedAsset.kind === "image" ? [await resizeImage(file)] : selectedAsset.kind === "video" ? await sampleVideo(file) : [];
        const reference: PreparedReference = { assetId: selectedAsset.id, analysisChannel: channel, ...(channel === "local" && hotWords.length ? { focusTerms: hotWords } : {}), name: selectedAsset.name, kind: selectedAsset.kind, canonicalName: selectedAsset.canonicalName, declaredIdentity: resolveDeclaredIdentity(selectedAsset, jobSettings.characterPolicy), role: selectedAsset.role, referenceUse: selectedAsset.referenceUse, sourceOf: channel === "local" ? selectedAsset.localSourceOf || "" : selectedAsset.sourceOf, note: channel === "local" ? selectedAsset.localNote || "" : selectedAsset.note, dataUrls };
        const payload = await postProvider({ action: "analyze", references: [reference] }, channel);
        const returned = (payload.analyses as AssetRecord["analysis"][])?.[0];
        analysis = returned ? { ...returned, channel } : undefined;
      }
      if (!analysis) throw new Error("The vision model returned no analysis.");
      const updated = { ...selectedAsset, ...(channel === "local" ? { localAnalysis: analysis } : { analysis }) };
      patchAsset(selectedAsset.id, channel === "local" ? { localAnalysis: analysis } : { analysis });
      const metadata = { canonicalName: updated.canonicalName, declaredIdentity: updated.declaredIdentity, role: updated.role, referenceUse: updated.referenceUse, sourceOf: updated.sourceOf, note: updated.note, localSourceOf: updated.localSourceOf, localNote: updated.localNote, trimStart: updated.trimStart, trimEnd: updated.trimEnd, width: updated.sourceWidth, height: updated.sourceHeight, duration: updated.sourceDuration };
      const saved = activeProject && updated.relativePath
        ? Boolean(await updateProjectAsset(activeProject.id, updated.relativePath, { metadata, ...(channel === "local" ? { localAnalysis: analysis as unknown as Record<string, unknown> } : { analysis: analysis as unknown as Record<string, unknown> }) }))
        : await writeAssetSidecar(updated);
      setMessage(`${selectedAsset.name} ${channel} analysis saved${saved ? `; ${sidecarName(selectedAsset.name)} updated on disk` : "; metadata retained in browser storage"}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Analysis failed."); }
    finally { setBusy(null); }
  }

  async function generatePrompt() {
    if (!simplePrompt.trim()) return setMessage("Write the simple action prompt first.");
    if (!chosenAssets.length) return setMessage("Check at least one asset in the library.");
    if (compiled.warnings.some((warning) => /at most/.test(warning))) return setMessage(compiled.warnings.join(" "));
    if (settings.provider === "demo") return setMessage("Connect OpenRouter or a local model server to expand the final prompt.");
    setBusy("generate");
    setMessage(`Expanding one continuous ${durationSeconds}-second take with ${settings.promptModel}…`);
    try {
      const payload = await postProvider({
        action: "expand-single",
        simplePrompt,
        durationSeconds,
        assets: chosenAssets.map(({ id, name, kind, canonicalName, declaredIdentity, role, referenceUse, sourceOf, note, localSourceOf, localNote }) => ({ id, name, kind, canonicalName, declaredIdentity, resolvedDeclaredIdentity: resolveDeclaredIdentity({ declaredIdentity, role }, jobSettings.characterPolicy), role, referenceUse, sourceOf, note, localSourceOf, localNote })),
        analyses: chosenAssets.flatMap((asset) => [asset.analysis ? { ...asset.analysis, channel: "strong" as const } : null, asset.localAnalysis ? { ...asset.localAnalysis, channel: "local" as const } : null]).filter(Boolean),
        attachments: compiled.attachments,
        subjects: compiled.subjects,
        taskTypes: compiled.taskTypes,
        characterPolicy: jobSettings.characterPolicy,
        requireNonDiegeticMusicNA,
      });
      const prompt = String(payload.prompt || "").trim();
      if (!prompt) throw new Error("The prompt model returned nothing.");
      setPromptHistory((current) => [prompt, generatedPrompt, ...current].filter((item, index, all) => item && all.indexOf(item) === index).slice(0, 5));
      setGeneratedPrompt(prompt);
      setMessage("Single-take H3 prompt generated. Review it, then copy or export the selected bundle.");
    } catch (error) {
      const raw = error instanceof ProviderRequestError && typeof error.payload.raw === "string" ? error.payload.raw.trim() : "";
      const errorMessage = error instanceof Error ? error.message : "Prompt expansion failed.";
      if (raw) {
        setPromptHistory((current) => [raw, generatedPrompt, ...current].filter((item, index, all) => item && all.indexOf(item) === index).slice(0, 5));
        setGeneratedPrompt(raw);
        setMessage(`${errorMessage} The raw return is retained for inspection.`);
      } else setMessage(errorMessage);
    } finally { setBusy(null); }
  }

  async function sealBundle() {
    const sourceIssues = activeProject ? [] : chosenAssets.filter((asset) => !fileStore.current.has(asset.id)).map((asset) => `${asset.name}: reload the source file.`);
    const currentIssues = [...new Set([...sealIssues, ...sourceIssues])];
    if (currentIssues.length) {
      const detail = currentIssues.join(" ");
      setSealFeedback(detail);
      setMessage(detail);
      return;
    }
    const resolvedSeed = seedMode === "random" ? randomSeed() : jobSettings.seed;
    const resolvedJobDesc = deriveJobDesc(simplePrompt, chosenAssets, jobDesc, verbFamilies);
    const createdAt = new Date();
    let managedFiles: Map<string, File>;
    try { managedFiles = new Map(await Promise.all(chosenAssets.map(async (asset) => [asset.id, await ensureAssetFile(asset)] as const))); }
    catch (error) { const detail = error instanceof Error ? error.message : "Could not load managed sources."; setSealFeedback(detail); setMessage(detail); return; }
    const assetHashes = await Promise.all(chosenAssets.map(async (asset) => ({ id: asset.id, sha256: await sha256Hex(managedFiles.get(asset.id)!), trimStart: asset.trimStart, trimEnd: asset.trimEnd })));
    const resolvedSettings = { ...jobSettings, title: activeProject?.name || jobSettings.title, seed: resolvedSeed };
    const jobId = await createJobId(resolvedJobDesc, { projectId: activeProject?.id || "legacy", createdAt: createdAt.toISOString(), seed: resolvedSeed, jobDesc: resolvedJobDesc, request: simplePrompt, prompt: generatedPrompt, assets: assetHashes, settings: resolvedSettings });
    const suggestedName = `${jobId}.dummyjob.zip`;
    const savePicker = (window as Window & { showSaveFilePicker?: (options?: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveFileHandleLike> }).showSaveFilePicker;
    let saveHandle: SaveFileHandleLike | null = null;
    if (savePicker) {
      try {
        setSealFeedback("Choose where to save the immutable job ZIP.");
        saveHandle = await savePicker({ suggestedName, types: [{ description: "Dummyplug job ZIP", accept: { "application/zip": [".zip"] } }] });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setSealFeedback("Seal canceled before hashing; no file was written.");
          return;
        }
        setSealFeedback(error instanceof Error ? error.message : "Could not choose a save destination.");
        return;
      }
    }
    setBusy("export");
    setSealFeedback(`Hashing ${chosenAssets.length} reference${chosenAssets.length === 1 ? "" : "s"}…`);
    setMessage(`Hashing ${chosenAssets.length} reference${chosenAssets.length === 1 ? "" : "s"} and sealing an immutable job…`);
    try {
      const result = await sealJobZip({
        assets: chosenAssets,
        files: managedFiles,
        sidecars: new Map(chosenAssets.map((asset) => [asset.id, JSON.stringify(makeReferenceSidecar(asset, { strong: settings, local: localSettings }), null, 2)])),
        prompt: generatedPrompt,
        request: simplePrompt,
        duration: durationSeconds,
        settings: resolvedSettings,
        subjects: compiled.subjects,
        jobId,
        projectName: activeProject?.name,
        jobDesc: resolvedJobDesc,
        requireNonDiegeticMusicNA,
        now: createdAt,
      });
      const blob = new Blob([result.bytes.slice().buffer], { type: "application/zip" });
      if (saveHandle) {
        const writable = await saveHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = suggestedName;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      setSealFeedback(`Saved ${suggestedName}.`);
      setMessage(`Sealed ${result.jobId}.dummyjob.zip with ${chosenAssets.length} hashed reference${chosenAssets.length === 1 ? "" : "s"}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not seal job.";
      setSealFeedback(detail);
      setMessage(detail);
    }
    finally { setBusy(null); }
  }

  function cancelRequest() {
    activeController.current?.abort();
    activeController.current = null;
    setBusy(null);
    setMessage("Provider request canceled.");
  }

  async function testProvider(channel: "strong" | "local" = "strong", silent = false) {
    const connection = channel === "local" ? localSettings : settings;
    const setConnectionStatus = channel === "local" ? setLocalProviderStatus : setProviderStatus;
    if (providerProbeActive.current || (silent && busy)) return;
    if (connection.provider === "demo") { setConnectionStatus("connected"); if (!silent) setMessage(`${channel} demo mode is ready and makes no network calls.`); return; }
    if (!connection.visionModel.trim()) { setConnectionStatus("unknown"); if (!silent) setMessage(`Choose the ${channel} vision model first.`); return; }
    if (connection.provider === "openrouter" && !connection.apiKey.trim()) { setConnectionStatus("unknown"); if (!silent) setMessage(`Enter the ${channel} OpenRouter API key first.`); return; }
    providerProbeActive.current = true;
    if (!silent) setBusy(channel === "local" ? "test-local" : "test-strong");
    try {
      const payload = await postProvider({ action: "test" }, channel);
      setConnectionStatus("connected");
      if (!silent) setMessage(`${channel}: ${String(payload.message || "provider connected.")}`);
    } catch (error) { setConnectionStatus("failed"); if (!silent) setMessage(error instanceof Error ? error.message : `${channel} connection test failed.`); }
    finally { providerProbeActive.current = false; if (!silent) setBusy(null); }
  }

  function patchPromptTemplate(id: PromptTemplateId, value: string) {
    setPromptOverrides((current) => {
      const next = { ...current };
      if (value === DEFAULT_PROMPT_TEMPLATES[id]) delete next[id];
      else next[id] = value;
      return next;
    });
  }

  function commitVerbVocabulary(value = verbText) {
    const parsed = parseVerbVocabulary(value);
    if (!parsed.length) { setMessage("Verb vocabulary needs at least one ‘lemma: forms’ line."); return; }
    setVerbFamilies(parsed);
    localStorage.setItem("dummyplug.verbFamilies.v1", JSON.stringify(parsed));
    setMessage(`Saved ${parsed.length} verb families for automatic job descriptions.`);
  }

  function resetVerbVocabulary() {
    setVerbFamilies(DEFAULT_VERB_FAMILIES);
    setVerbText(verbVocabularyText(DEFAULT_VERB_FAMILIES));
    localStorage.removeItem("dummyplug.verbFamilies.v1");
    setMessage("Restored the default verb vocabulary.");
  }

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand-block"><span className="brand-mark" aria-hidden="true"><img src="/dummyplug-head.png" alt="" /></span><div><h1>dummyplug</h1><p>job bundler · MiniMax H3</p></div></div><div className="top-actions"><span className={`provider-state provider-${settings.provider}`} title="strong provider"><i className={`provider-dot ${providerStatus}`} aria-hidden="true" />strong {settings.provider}</span><span className={`provider-state provider-${localSettings.provider}`} title="local provider"><i className={`provider-dot ${localProviderStatus}`} aria-hidden="true" />local {localSettings.provider}</span><button className="project-button" onClick={() => setProjectDialogOpen(true)}>{activeProject?.name || "choose project"}</button><button className="heart-button" aria-label="settings" title="settings" onClick={() => setSettingsOpen(true)}><span aria-hidden="true">♥</span></button></div></header>
      <section className="status-strip" aria-live="polite"><span className={busy ? "pulse-dot" : "status-dot"} /><span>{message}</span><span className="status-metrics">{assets.length} assets · {analyzedCount} analyzed · {chosenAssets.length} selected</span></section>

      <div className="single-grid">
        <aside className="panel library-panel">
          <div className="panel-head"><div><span className="step-index">01</span><h2>asset library</h2></div><span>{assets.length}</span></div>
          <div className={`drop-zone ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}>
            <input ref={fileInputRef} type="file" multiple accept="image/*,video/*,audio/*,.json" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} />
            <button className="drop-picker" onClick={() => void pickReferenceFiles()}><strong>import assets + matching json</strong><span>copies files into this project</span></button>
          </div>
          <div className="source-buttons"><button className="secondary folder-button" onClick={() => void pickReferenceFolder()}>import folder</button><button className="secondary folder-button" disabled={!activeProject} onClick={() => void recrawlProject()}>refresh library</button></div>
          <div className="asset-filters"><input value={assetFilterText} onChange={(event) => setAssetFilterText(event.target.value)} placeholder="filter filename or metadata" aria-label="Filter assets by filename or metadata" /><select value={assetFilterKind} onChange={(event) => setAssetFilterKind(event.target.value as "all" | AssetKind)} aria-label="Filter assets by type"><option value="all">all types</option><option value="image">images</option><option value="video">videos</option><option value="audio">audio</option></select></div>
          <div className="library-view-tabs"><button className={libraryView === "list" ? "active" : ""} onClick={() => setLibraryView("list")}>list</button><button className={libraryView === "folders" ? "active" : ""} onClick={() => setLibraryView("folders")}>folders</button></div>
          {libraryView === "list" ? <div className="asset-database">
            {visibleAssets.map((asset) => { const index = assets.findIndex((candidate) => candidate.id === asset.id); return <article key={asset.id} className={`db-row ${selectedAsset?.id === asset.id ? "active" : ""}`}>
              <button type="button" className="asset-check" title="Include in the current job" aria-pressed={asset.selected} onClick={(event) => { event.stopPropagation(); toggleJobAsset(asset.id); }}><span>{asset.selected ? "✓" : ""}</span></button>
              <button className="db-select" onClick={() => setSelectedAssetId(asset.id)}>
              <div className="db-thumb">{asset.kind === "image" && asset.previewUrl ? <img src={asset.previewUrl} alt="" /> : asset.kind === "video" && asset.previewUrl ? <video src={asset.previewUrl} muted /> : <span>{asset.kind === "audio" ? "♫" : "?"}</span>}<b>{index + 1}</b></div>
              <div className="db-copy"><strong>{asset.canonicalName || asset.name}</strong><span>{asset.role} · {asset.referenceUse} · {asset.analysis ? "strong saved" : "strong empty"} · {asset.localAnalysis ? "local saved" : "local empty"}</span><p>{asset.sourceOf || asset.localSourceOf || asset.note || asset.localNote || "no source-of authority yet"}</p></div>
              </button>
              <button className="row-remove" onClick={(event) => { event.stopPropagation(); void removeAsset(asset.id); }} aria-label={`Move ${asset.name} to project trash`}>×</button>
            </article>; })}
            {!assets.length ? <p className="empty-copy">Every image, video, and audio file becomes one durable metadata record.</p> : !visibleAssets.length && <p className="empty-copy">No assets match this filter.</p>}
          </div> : <FolderLibraryView assets={visibleAssets} folders={libraryFolders} selectedAssetId={selectedAsset?.id || ""} onSelect={setSelectedAssetId} onToggle={toggleJobAsset} onMove={(asset, folder) => organizeAsset("move", asset, folder)} onRename={(asset, name) => organizeAsset("rename", asset, name)} onTrash={(asset) => removeAsset(asset.id)} onCreateFolder={createLibraryFolder} onRemoveFolder={removeLibraryFolder} onMoveFolder={(path, destination) => organizeFolder("move", path, destination)} onRenameFolder={(path, name) => organizeFolder("rename", path, name)} />}
        </aside>

        <section className="panel metadata-panel">
          <div className="panel-head"><div><span className="step-index">02</span><h2>asset metadata</h2></div>{selectedAsset && <span>{sidecarName(selectedAsset.name)}</span>}</div>
          {selectedAsset ? <>
            <div className="asset-preview">{selectedAsset.kind === "image" && selectedAsset.previewUrl ? <img src={selectedAsset.previewUrl} alt={selectedAsset.canonicalName || selectedAsset.name} /> : selectedAsset.kind === "video" && selectedAsset.previewUrl ? <video src={selectedAsset.previewUrl} controls /> : selectedAsset.kind === "audio" && selectedAsset.previewUrl ? <audio src={selectedAsset.previewUrl} controls /> : <p>source file not loaded</p>}</div>
            <div className="asset-fileline"><strong>{selectedAsset.name}</strong><span>{humanBytes(selectedAsset.size)} · {selectedAsset.id}</span></div>
            <div className="source-spec"><span>{selectedAsset.sourceWidth && selectedAsset.sourceHeight ? `${selectedAsset.sourceWidth}×${selectedAsset.sourceHeight}` : "dimensions unknown"}</span><span>{selectedAsset.sourceDuration != null ? `${selectedAsset.sourceDuration.toFixed(3)}s` : "duration unknown"}</span><span>{selectedAsset.mimeType}</span></div>
            {selectedAsset.kind === "video" && <div className="trim-controls"><label><span>trim start</span><input type="number" min={0} step={0.001} value={selectedAsset.trimStart ?? 0} onChange={(event) => patchAsset(selectedAsset.id, { trimStart: Number(event.target.value) })} /></label><label><span>trim end</span><input type="number" min={0.001} step={0.001} value={selectedAsset.trimEnd ?? selectedAsset.sourceDuration ?? ""} onChange={(event) => patchAsset(selectedAsset.id, { trimEnd: Number(event.target.value) })} placeholder="seconds" /></label><button type="button" className="secondary" disabled={selectedAsset.sourceDuration == null} onClick={() => patchAsset(selectedAsset.id, { trimStart: 0, trimEnd: selectedAsset.sourceDuration })}>whole source</button>{validateVideoTrim(selectedAsset) && <p>{validateVideoTrim(selectedAsset)}</p>}</div>}
            <label className="meta-field"><span>canonical name</span><input value={selectedAsset.canonicalName} onChange={(event) => patchAsset(selectedAsset.id, { canonicalName: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="Rabbit" /></label>
            <label className="meta-field"><span>declared identity</span><input value={selectedAsset.declaredIdentity} onChange={(event) => patchAsset(selectedAsset.id, { declaredIdentity: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder={selectedAsset.role === "character" && jobSettings.characterPolicy.allCharactersTransgenderWomen ? "project default: transgender woman; she/her" : "manual identity authority (optional)"} /><small>This manual fact overrides cast lock for this asset. Vision models may use it but may never revise it from anatomy.</small></label>
            <label className="meta-field"><span>role</span><select value={selectedAsset.role} onChange={(event) => patchAsset(selectedAsset.id, { role: event.target.value as AssetRole })} onBlur={() => void saveSelectedMetadata()}>{ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
            <label className="meta-field"><span>H3 use</span><select value={selectedAsset.referenceUse} onChange={(event) => patchAsset(selectedAsset.id, { referenceUse: event.target.value as ReferenceUse })} onBlur={() => void saveSelectedMetadata()}>{REFERENCE_USE_OPTIONS[selectedAsset.kind].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>Subject sources are cited inside a Subject. Picture and Video entries are created only for the explicit structural uses named here.</small></label>
            <section className="analysis-channel analysis-channel-strong"><div className="analysis-channel-head"><strong>strong</strong><span>primary visual authority</span></div><label className="meta-field"><span>strong source of</span><textarea value={selectedAsset.sourceOf} onChange={(event) => patchAsset(selectedAsset.id, { sourceOf: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="face, body, wardrobe, drunken happy expression" /></label><label className="meta-field"><span>strong note</span><textarea value={selectedAsset.note} onChange={(event) => patchAsset(selectedAsset.id, { note: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="This is the main character, Rabbit. She's drunk and happy in this reference." /></label><div className="metadata-actions"><button className="primary" disabled={Boolean(busy) || selectedAsset.missingFile || selectedAsset.kind === "audio"} onClick={() => void analyzeSelected("strong")}>{busy === "analyze-strong" ? "analyzing strongly…" : selectedAsset.kind === "audio" ? "manual metadata for audio" : selectedAsset.analysis ? "re-analyze strongly" : "analyze strongly"}</button><button className="secondary" onClick={() => downloadSidecar(selectedAsset)}>download json</button></div><VisionRecord analysis={selectedAsset.analysis} channel="strong" /></section>
            <section className="analysis-channel analysis-channel-local"><div className="analysis-channel-head"><strong>dirty focus</strong><span>local visible evidence only</span></div><label className="meta-field"><span>dirty-focus source of</span><textarea value={selectedAsset.localSourceOf || ""} onChange={(event) => patchAsset(selectedAsset.id, { localSourceOf: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="anatomy, explicit state, NSFW details, local-only authority" /></label><label className="meta-field"><span>dirty-focus note</span><textarea value={selectedAsset.localNote || ""} onChange={(event) => patchAsset(selectedAsset.id, { localNote: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="Manual direction for the local dirty-focus scan." /></label><div className="metadata-actions local-analysis-actions"><button className="primary" disabled={Boolean(busy) || selectedAsset.missingFile || selectedAsset.kind === "audio" || (localSettings.provider !== "demo" && !localSettings.visionModel.trim())} onClick={() => void analyzeSelected("local")}>{busy === "analyze-local" ? "scanning dirty focus…" : selectedAsset.kind === "audio" ? "manual metadata for audio" : localSettings.provider !== "demo" && !localSettings.visionModel.trim() ? "set local model in ♥" : selectedAsset.localAnalysis ? "re-scan dirty focus" : "scan dirty focus"}</button></div><VisionRecord analysis={selectedAsset.localAnalysis} channel="local" /></section>
          </> : <div className="vision-empty"><span>select an asset</span><p>Its preview, your durable tags, and the vision record appear here.</p></div>}
        </section>

        <aside className="panel prompt-panel-single">
          <div className="panel-head"><div><span className="step-index">03</span><h2>job</h2></div><span className={validation ? validation.valid && characterValidation?.valid ? "validation-ok" : "validation-bad" : "validation-pending"}>{validation ? validation.valid && characterValidation?.valid ? "six-part valid" : "needs repair" : "not generated"}</span></div>
          <JobAttachmentStrip assets={chosenAssets} onReorder={reorderJobAssets} onRemove={toggleJobAsset} onOpen={setSelectedAssetId} />
          <label className="job-desc-field"><span>job description</span><input maxLength={30} value={jobDesc} onChange={(event) => setJobDesc(normalizeJobDesc(event.target.value))} placeholder="optional · up to 30 characters" />{!jobDesc.trim() && <small>automatic: {resolvedJobDescPreview}</small>}</label>
          <label className="simple-prompt"><span>simple prompt</span><textarea value={simplePrompt} onChange={(event) => setSimplePrompt(event.target.value)} placeholder="Rabbit and her friend walk from left to right through the attached landscape." /></label>
          <div className="draft-controls"><label>duration <input type="number" min={1} max={20} value={durationSeconds} onChange={(event) => setDurationSeconds(Math.max(1, Math.min(20, Number(event.target.value) || 10)))} /> seconds</label><label className="seed-mode"><input type="checkbox" checked={seedMode === "random"} onChange={(event) => setSeedMode(event.target.checked ? "random" : "fixed")} />randomize seed when sealing</label>{seedMode === "fixed" && <label>seed <input type="number" min={0} max={Number.MAX_SAFE_INTEGER} value={jobSettings.seed} onChange={(event) => patchJobSettings({ seed: Number(event.target.value) })} /></label>}</div>
          <div className="project-output-summary"><span>project output</span><strong>{jobSettings.width}×{jobSettings.height} · {jobSettings.fps} fps · {jobSettings.outputContainer}/{jobSettings.audioCodec}{jobSettings.characterPolicy.allCharactersTransgenderWomen ? " · cast lock on" : ""}</strong><button onClick={() => setProjectDialogOpen(true)}>edit</button></div>
          <div className="task-prefix">[{compiled.taskTypes.join(" + ") || "reference generation"}]</div>
          <div className="attachment-list"><div><strong>resolved subjects + reference labels</strong><span>{compiled.subjects.length} · {compiled.attachments.length}</span></div>{compiled.subjects.map((subject) => <p className="subject-map-row" key={subject.label}><b>{subject.label}</b><span>{subject.canonicalName}</span><em>{subject.attachmentLabels.join(" + ")}</em></p>)}{compiled.attachments.map((attachment) => { const asset = assets.find((item) => item.id === attachment.assetId)!; return <p key={attachment.assetId}><b>{attachment.label}</b><span>{attachment.standaloneEntry ? "standalone entry" : "inside Subject only"}</span><em>{asset.sourceOf || asset.role}</em></p>; })}{!compiled.attachments.length && <p className="attachment-empty">Check assets in the library.</p>}</div>
          {compiled.warnings.length > 0 && <div className="warning-box">{compiled.warnings.map((warning) => <p key={warning}>△ {warning}</p>)}</div>}
          <button className="primary generate-single" disabled={Boolean(busy) || !simplePrompt.trim() || !chosenAssets.length} onClick={() => void generatePrompt()}>{busy === "generate" ? "writing prompt…" : "generate six-part prompt"}</button>
          {promptHistory.length > 0 && <label className="prompt-history"><span>recent generated versions</span><select value="" onChange={(event) => { const remembered = promptHistory[Number(event.target.value)]; if (remembered) setGeneratedPrompt(remembered); }}><option value="" disabled>restore one of the last {promptHistory.length}</option>{promptHistory.map((prompt, index) => <option value={index} key={`${index}-${prompt.slice(0, 24)}`}>version {index + 1} · {prompt.replace(/\s+/g, " ").slice(0, 52)}</option>)}</select></label>}
          <textarea className="prompt-output single-output" value={generatedPrompt} onChange={(event) => setGeneratedPrompt(event.target.value)} placeholder="The expanded six-part H3 prompt appears here. It will contain exactly one [Shot 1]." spellCheck={false} />
          <label className="music-na-control"><input type="checkbox" checked={requireNonDiegeticMusicNA} onChange={(event) => { const checked = event.target.checked; setRequireNonDiegeticMusicNA(checked); if (checked && generatedPrompt.trim()) setGeneratedPrompt(enforceNonDiegeticMusicNA(generatedPrompt)); }} /><code>non_diegetic_music: N/A</code></label>
          {generatedPrompt.trim() && hotWordAudit.missingFromMetadata.length > 0 && <div className="seal-feedback hot-word-warning"><strong>Some metadata Dirty Focus terms don&apos;t appear in final prompt!</strong><span>missing: {hotWordAudit.missingFromMetadata.join(", ")}</span></div>}
          {generatedPrompt.trim() && hotWordAudit.missingFromSimplePrompt.length > 0 && <div className="seal-feedback hot-word-warning"><strong>Some Dirty Focus terms from simple prompt don&apos;t appear in final prompt!</strong><span>missing: {hotWordAudit.missingFromSimplePrompt.join(", ")}</span></div>}
          <div className={`seal-feedback ${sealIssues.length ? "error" : sealFeedback ? "active" : "ready"}`} aria-live="polite">{sealIssues.length ? sealIssues[0] : sealFeedback || "Ready to hash and seal this immutable job."}</div>
          <div className="single-actions"><button className="secondary" disabled={!generatedPrompt} onClick={() => void navigator.clipboard.writeText(generatedPrompt).then(() => setMessage("Prompt copied."))}>copy prompt</button><button className="primary" disabled={!generatedPrompt || busy === "export"} onClick={() => void sealBundle()}>{busy === "export" ? "hashing + sealing…" : "seal job zip"}</button></div>
        </aside>
      </div>

      <ProjectDialog open={projectDialogOpen} projects={projects} activeProjectId={activeProject?.id || ""} activeProjectName={activeProject?.name || ""} activeProjectPath={activeProject ? `${projectRoot.replace(/[\\/]$/, "")}\\${activeProject.name}` : projectRoot} settings={activeProject?.outputSettings || DEFAULT_PROJECT_OUTPUT_SETTINGS} onClose={() => setProjectDialogOpen(false)} onSelect={(id) => { void openProject(id).catch((error) => setMessage(error instanceof Error ? error.message : "Could not open the project.")); }} onCreate={createAndOpenProject} legacyAssetCount={legacyAssetCount} onMigrate={migrateLegacyWorkspace} onSettingsChange={(patch) => void patchProjectOutputSettings(patch)} />

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-sheet" role="dialog" aria-modal="true"><div className="settings-head"><div><span className="heart-large">♥</span><div><h2>{settingsPage === "connection" ? "model connections" : settingsPage === "prompts" ? "system prompts" : settingsPage === "naming" ? "job naming" : "dirty focus"}</h2><p>{settingsPage === "connection" ? "Separate strong and local analysis paths; strong also writes the final prompt." : settingsPage === "prompts" ? "The exact recipes used by this reduced workflow." : settingsPage === "naming" ? "Editable verb families used by automatic job descriptions." : "Private visual inspection terms and carry-through checks."}</p></div></div><button onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></div><nav className="inline-settings-tabs settings-tabs-four"><button className={settingsPage === "connection" ? "active" : ""} onClick={() => setSettingsPage("connection")}>connection</button><button className={settingsPage === "prompts" ? "active" : ""} onClick={() => setSettingsPage("prompts")}>prompts</button><button className={settingsPage === "naming" ? "active" : ""} onClick={() => setSettingsPage("naming")}>naming</button><button className={settingsPage === "dirty-focus" ? "active" : ""} onClick={() => setSettingsPage("dirty-focus")}>dirty focus</button></nav>{settingsPage === "connection" ? <>
        <div className={`settings-status ${busy ? "active" : ""}`} aria-live="polite"><strong>{busy?.startsWith("test-") ? "testing connection…" : busy ? "request running…" : "provider status"}</strong><p>{message}</p></div>
        <div className="connection-profiles"><ConnectionEditor channel="strong" value={settings} status={providerStatus} busy={Boolean(busy)} onChange={setSettings} onTest={() => void testProvider("strong")} /><ConnectionEditor channel="local" value={localSettings} status={localProviderStatus} busy={Boolean(busy)} onChange={setLocalSettings} onTest={() => void testProvider("local")} /></div>
        <div className="settings-actions"><button className="secondary" onClick={() => { setSettings(DEFAULT_SETTINGS); setLocalSettings(DEFAULT_LOCAL_SETTINGS); }}>reset models</button><button className="secondary request-reset" onClick={cancelRequest}>{busy ? "cancel request" : "reset request"}</button><button className="primary" onClick={() => setSettingsOpen(false)}>done</button></div>
      </> : settingsPage === "prompts" ? <><div className="prompt-registry-intro"><strong>DaSiWa single-take recipes</strong><p>Strong vision, local dirty-focus scans and probes, and the final one-take writer are editable here.</p><button className="secondary" onClick={() => setPromptOverrides({})}>reset to defaults</button></div><div className="prompt-registry">{EXPOSED_PROMPT_TEMPLATES.map((item) => <article className="system-prompt-card" key={item.id}><div className="system-prompt-head"><div><h3>{item.title}</h3><span>{item.modelRole}</span></div><button className="secondary" onClick={() => { void navigator.clipboard.writeText(promptOverrides[item.id] ?? item.template); setCopiedPromptId(item.id); window.setTimeout(() => setCopiedPromptId(null), 1200); }}>{copiedPromptId === item.id ? "copied" : "copy"}</button></div><p>{item.description}</p><textarea value={promptOverrides[item.id] ?? item.template} onChange={(event) => patchPromptTemplate(item.id, event.target.value)} spellCheck={false} /></article>)}</div></> : settingsPage === "naming" ? <div className="naming-settings"><p>One family per line: <code>walk: walk, walks, walked, walking</code>. “to be” is deliberately excluded.</p><textarea value={verbText} onChange={(event) => setVerbText(event.target.value)} onBlur={() => void commitVerbVocabulary()} spellCheck={false} /><div><button className="secondary" onClick={resetVerbVocabulary}>reset vocabulary</button><button className="primary" onClick={() => void commitVerbVocabulary()}>save vocabulary</button></div></div> : <div className="hot-word-settings"><p>One word or phrase per line. JoyCaption receives a deterministic, narrow request to locate and describe each term&apos;s visible appearance and qualities. Unresolved terms receive individual follow-up probes.</p><p>The vocabulary stays in this browser and is never sent to the strong provider. Dummyplug also checks selected metadata and the simple prompt against the final generated prompt.</p><textarea value={hotWordText} onChange={(event) => setHotWordText(event.target.value)} placeholder="one dirty-focus term per line" spellCheck={false} /><div><span>{hotWords.length} Dirty Focus term{hotWords.length === 1 ? "" : "s"}</span><button className="primary" onClick={() => setMessage(`${hotWords.length} Dirty Focus term${hotWords.length === 1 ? "" : "s"} saved in this browser.`)}>save dirty focus</button></div></div>}
      </section></div>}
    </main>
  );
}
