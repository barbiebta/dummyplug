"use client";
/* eslint-disable @next/next/no-img-element -- browser blob URLs are not compatible with the image optimizer */
/* eslint-disable jsx-a11y/media-has-caption -- imported visual and motion references do not include caption tracks */
/* eslint-disable jsx-a11y/no-static-element-interactions -- the modal backdrop only closes on direct backdrop clicks */

import { useEffect, useMemo, useRef, useState } from "react";
import { loadBrowserWorkspace, saveBrowserWorkspace, type PersistedDirectoryHandle, type PersistedFileHandle, type PersistedWorkspace } from "../../lib/browser-workspace";
import { DEFAULT_JOB_SETTINGS, randomSeed, sealJobZip, validateJobSettings, validateVideoTrim } from "../../lib/job-bundle";
import { makeReferenceSidecar, readReferenceSidecar, sidecarMatchKey, sidecarName } from "../../lib/reference-sidecar";
import { compileAttachments, makeDemoAnalysis, validateSingleShotPrompt } from "../../lib/single-h3";
import { DEFAULT_PROMPT_TEMPLATES, EXPOSED_PROMPT_TEMPLATES, type PromptTemplateId, type PromptTemplateMap } from "../../lib/single-prompts";
import type { AssetKind, AssetRecord, AssetRole, JobSettings, ModelSettings, PreparedReference, ReferenceUse } from "../../lib/types";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"connection" | "prompts">("connection");
  const [promptOverrides, setPromptOverrides] = useState<Partial<PromptTemplateMap>>({});
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const [metadataDirectoryName, setMetadataDirectoryName] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [busy, setBusy] = useState<"analyze" | "generate" | "export" | "test" | null>(null);
  const [message, setMessage] = useState("Add assets, tag what they are sources of, then select references for one continuous take.");
  const [dragging, setDragging] = useState(false);
  const [assetFilterKind, setAssetFilterKind] = useState<"all" | AssetKind>("all");
  const [assetFilterText, setAssetFilterText] = useState("");
  const [sealFeedback, setSealFeedback] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileStore = useRef(new Map<string, File>());
  const sourceHandleStore = useRef(new Map<string, FileHandleLike>());
  const sourceDirectoryStore = useRef(new Map<string, { directory: DirectoryHandleLike; sourceName: string }>());
  const metadataDirectoryStore = useRef<DirectoryHandleLike | null>(null);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const rawSettings = localStorage.getItem("dummyplug.single.settings.v2");
      const sessionKey = sessionStorage.getItem("dummyplug.single.v2.apiKey") || "";
      const rawPrompts = localStorage.getItem("dummyplug.singlePromptOverrides.v2");
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
        const directory = saved.metadataDirectory;
        if (directory) {
          metadataDirectoryStore.current = directory;
          setMetadataDirectoryName(directory.name || "selected folder");
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
            missingFile: !file,
          });
        }
        setAssets(restored);
        setSelectedAssetId(saved.selectedAssetId || restored[0]?.id || "");
        setSimplePrompt(saved.simplePrompt || "");
        setDurationSeconds(Math.max(1, Math.min(20, saved.durationSeconds || 10)));
        setJobSettings({ ...DEFAULT_JOB_SETTINGS, ...(saved.jobSettings || {}) });
        setGeneratedPrompt(saved.generatedPrompt || "");
        setPromptHistory((saved.promptHistory || []).filter(Boolean).slice(0, 5));
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
    if (Object.keys(promptOverrides).length) localStorage.setItem("dummyplug.singlePromptOverrides.v2", JSON.stringify(promptOverrides));
    else localStorage.removeItem("dummyplug.singlePromptOverrides.v2");
  }, [promptOverrides, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
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
      };
      const light: PersistedWorkspace = { ...persisted, metadataDirectory: undefined, assets: persisted.assets.map(({ record }) => ({ record })) };
      try { localStorage.setItem("dummyplug.single.v2.workspace.light", JSON.stringify(light)); } catch { /* IndexedDB is primary */ }
      void saveBrowserWorkspace(persisted).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [assets, durationSeconds, generatedPrompt, jobSettings, promptHistory, selectedAssetId, simplePrompt, storageReady]);

  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) || assets[0];
  const chosenAssets = assets.filter((asset) => asset.selected);
  const compiled = useMemo(() => compileAttachments(chosenAssets), [chosenAssets]);
  const validation = generatedPrompt ? validateSingleShotPrompt(generatedPrompt, compiled.attachments, compiled.subjects) : null;
  const analyzedCount = assets.filter((asset) => asset.analysis).length;
  const visibleAssets = assets.filter((asset) => {
    if (assetFilterKind !== "all" && asset.kind !== assetFilterKind) return false;
    const query = assetFilterText.trim().toLocaleLowerCase();
    if (!query) return true;
    return [asset.name, asset.canonicalName, asset.role, asset.referenceUse, asset.sourceOf, asset.note, asset.analysis ? JSON.stringify(asset.analysis) : ""].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
  });
  const sealIssues = [
    ...(!generatedPrompt.trim() ? ["Write or generate the six-part prompt."] : validation && !validation.valid ? ["The six-part prompt does not validate against the current selected references."] : []),
    ...compiled.warnings,
    ...validateJobSettings(jobSettings, durationSeconds),
    ...chosenAssets.map(validateVideoTrim).filter((issue): issue is string => Boolean(issue)),
    ...chosenAssets.filter((asset) => asset.missingFile).map((asset) => `${asset.name}: reload the source file.`),
  ];

  async function postProvider(body: Record<string, unknown>) {
    if (settings.provider === "openrouter" && !settings.apiKey.trim()) {
      throw new ProviderRequestError("Open settings and enter your OpenRouter API key.", {});
    }
    const controller = new AbortController();
    activeController.current = controller;
    const endpoint = settings.provider === "demo" ? "/api/provider" : "/provider-bridge";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, settings, ...(Object.keys(promptOverrides).length ? { promptTemplates: promptOverrides } : {}) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(text) as Record<string, unknown>; }
      catch { payload = { error: text.trim().slice(0, 700) || `Provider returned ${response.status} without JSON.` }; }
      if (!response.ok) throw new ProviderRequestError(String(payload.error || "Provider request failed."), payload);
      return payload;
    } catch (error) {
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
    const sidecar = makeReferenceSidecar(asset, settings);
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

  async function chooseMetadataDirectory(importExisting = true) {
    const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandleLike> }).showDirectoryPicker;
    if (!picker) return setMessage("Direct metadata files require Chrome or another browser with folder access. Per-asset JSON download remains available.");
    try {
      const directory = await picker({ mode: "readwrite" });
      metadataDirectoryStore.current = directory;
      setMetadataDirectoryName(directory.name || "selected folder");
      let importedCount = 0;
      let nextAssets = assets;
      if (importExisting) {
        const importedById = new Map<string, NonNullable<Awaited<ReturnType<typeof readCachedSidecar>>>>();
        for (const asset of assets) {
          const file = fileStore.current.get(asset.id);
          if (!file) continue;
          const imported = await readCachedSidecar(directory, file, asset.id);
          if (imported) { importedById.set(asset.id, imported); importedCount += 1; }
        }
        nextAssets = assets.map((asset) => {
          const imported = importedById.get(asset.id);
          return imported ? { ...asset, canonicalName: imported.canonicalName ?? asset.canonicalName, role: imported.role ?? asset.role, referenceUse: imported.referenceUse ?? asset.referenceUse, sourceOf: imported.sourceOf ?? asset.sourceOf, note: imported.note ?? asset.note, analysis: imported.analysis ?? asset.analysis } : asset;
        });
        setAssets(nextAssets);
      }
      let written = 0;
      for (const asset of nextAssets) if (await writeAssetSidecar(asset, directory)) written += 1;
      setMessage(`Metadata folder “${directory.name || "selected folder"}” ready; ${written} sidecar${written === 1 ? "" : "s"} written${importedCount ? ` and ${importedCount} loaded` : ""}.`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(error instanceof Error ? error.message : "Could not open metadata folder.");
    }
  }

  async function addFiles(files: FileList | File[], relativePaths = new Map<File, string>(), directories = new Map<File, DirectoryHandleLike>(), handles = new Map<File, FileHandleLike>()) {
    const incoming = [...files];
    const sidecars = new Map<string, File>();
    for (const file of incoming) if (file.type === "application/json" || file.name.toLocaleLowerCase().endsWith(".json")) sidecars.set(sidecarMatchKey(relativePaths.get(file) || file.webkitRelativePath || file.name), file);
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
        role: imported?.role ?? reusable?.role ?? (kind === "audio" ? "audio" : "general"),
        referenceUse: imported?.referenceUse ?? reusable?.referenceUse ?? defaultReferenceUse(kind),
        sourceOf: imported?.sourceOf ?? reusable?.sourceOf ?? "",
        note: imported?.note ?? reusable?.note ?? "",
        analysis: imported?.analysis ?? (changed ? undefined : reusable?.analysis),
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

  async function reloadSources() {
    const replacements = new Map<string, File>();
    const sourceMetadata = new Map<string, Pick<AssetRecord, "sourceWidth" | "sourceHeight" | "sourceDuration">>();
    let reloaded = 0;
    for (const asset of assets) {
      const handle = sourceHandleStore.current.get(asset.id);
      if (!handle) continue;
      try {
        if (handle.queryPermission && await handle.queryPermission({ mode: "read" }) !== "granted" && (!handle.requestPermission || await handle.requestPermission({ mode: "read" }) !== "granted")) continue;
        const file = await handle.getFile();
        fileStore.current.set(asset.id, file);
        replacements.set(asset.id, file);
        try { sourceMetadata.set(asset.id, await inspectSource(file, asset.kind)); } catch { /* retain prior inspection */ }
        reloaded += 1;
      } catch { /* picker fallback below */ }
    }
    if (!reloaded) return void pickReferenceFiles();
    setAssets((current) => current.map((asset) => {
      const file = replacements.get(asset.id);
      if (!file) return asset;
      const changed = file.size !== asset.size || (asset.lastModified != null && file.lastModified !== asset.lastModified);
      const inspected = sourceMetadata.get(asset.id) || {};
      if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl);
      return { ...asset, ...inspected, name: file.name, size: file.size, lastModified: file.lastModified, mimeType: mimeFor(file, asset.kind), previewUrl: URL.createObjectURL(file), missingFile: false, analysis: changed ? undefined : asset.analysis, ...(asset.kind === "video" && inspected.sourceDuration != null && (asset.trimEnd == null || changed) ? { trimStart: 0, trimEnd: inspected.sourceDuration } : {}) };
    }));
    setMessage(`Reloaded ${reloaded} source file${reloaded === 1 ? "" : "s"}.`);
  }

  function patchAsset(id: string, patch: Partial<AssetRecord>) {
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, ...patch } : asset));
  }

  function moveAsset(id: string, direction: -1 | 1) {
    setAssets((current) => {
      const index = current.findIndex((asset) => asset.id === id);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  function patchJobSettings(patch: Partial<JobSettings>) {
    setJobSettings((current) => ({ ...current, ...patch }));
  }

  async function saveSelectedMetadata() {
    const current = assets.find((asset) => asset.id === selectedAssetId);
    if (!current) return;
    try {
      if (await writeAssetSidecar(current)) setMessage(`${sidecarName(current.name)} saved.`);
      else setMessage("Metadata is saved in the browser. Load a folder or choose a metadata folder to write the adjacent JSON file.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save metadata JSON."); }
  }

  function downloadSidecar(asset: AssetRecord) {
    const sidecar = makeReferenceSidecar(asset, settings);
    if (!sidecar) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(sidecar, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = sidecarName(asset.name);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function removeAsset(id: string) {
    const target = assets.find((asset) => asset.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    fileStore.current.delete(id);
    sourceHandleStore.current.delete(id);
    sourceDirectoryStore.current.delete(id);
    setAssets((current) => current.filter((asset) => asset.id !== id));
    if (selectedAssetId === id) setSelectedAssetId(assets.find((asset) => asset.id !== id)?.id || "");
  }

  async function analyzeSelected() {
    if (!selectedAsset) return setMessage("Select an asset first.");
    const file = fileStore.current.get(selectedAsset.id);
    if (!file) return setMessage("Reload this source file before analysis.");
    setBusy("analyze");
    setMessage(`Analyzing ${selectedAsset.name} as ${selectedAsset.role}…`);
    try {
      let analysis: AssetRecord["analysis"];
      if (settings.provider === "demo") analysis = makeDemoAnalysis(selectedAsset);
      else {
        const dataUrls = selectedAsset.kind === "image" ? [await resizeImage(file)] : selectedAsset.kind === "video" ? await sampleVideo(file) : [];
        const reference: PreparedReference = { assetId: selectedAsset.id, name: selectedAsset.name, kind: selectedAsset.kind, canonicalName: selectedAsset.canonicalName, role: selectedAsset.role, referenceUse: selectedAsset.referenceUse, sourceOf: selectedAsset.sourceOf, note: selectedAsset.note, dataUrls };
        const payload = await postProvider({ action: "analyze", references: [reference] });
        analysis = (payload.analyses as AssetRecord["analysis"][])?.[0];
      }
      if (!analysis) throw new Error("The vision model returned no analysis.");
      const updated = { ...selectedAsset, analysis };
      patchAsset(selectedAsset.id, { analysis });
      const saved = await writeAssetSidecar(updated);
      setMessage(`${selectedAsset.name} analyzed${saved ? `; ${sidecarName(selectedAsset.name)} updated on disk` : "; metadata retained in browser storage"}.`);
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
        assets: chosenAssets.map(({ id, name, kind, canonicalName, role, referenceUse, sourceOf, note }) => ({ id, name, kind, canonicalName, role, referenceUse, sourceOf, note })),
        analyses: chosenAssets.map((asset) => asset.analysis).filter(Boolean),
        attachments: compiled.attachments,
        subjects: compiled.subjects,
        taskTypes: compiled.taskTypes,
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
    const sourceIssues = chosenAssets.filter((asset) => !fileStore.current.has(asset.id)).map((asset) => `${asset.name}: reload the source file.`);
    const currentIssues = [...new Set([...sealIssues, ...sourceIssues])];
    if (currentIssues.length) {
      const detail = currentIssues.join(" ");
      setSealFeedback(detail);
      setMessage(detail);
      return;
    }
    const jobId = crypto.randomUUID();
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
        files: new Map(chosenAssets.flatMap((asset) => { const file = fileStore.current.get(asset.id); return file ? [[asset.id, file] as const] : []; })),
        sidecars: new Map(chosenAssets.map((asset) => [asset.id, JSON.stringify(makeReferenceSidecar(asset, settings), null, 2)])),
        prompt: generatedPrompt,
        request: simplePrompt,
        duration: durationSeconds,
        settings: jobSettings,
        subjects: compiled.subjects,
        jobId,
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

  async function testProvider() {
    if (settings.provider === "demo") return setMessage("Demo mode is ready and makes no network calls.");
    setBusy("test");
    try {
      const payload = await postProvider({ action: "test" });
      setMessage(String(payload.message || "Provider connected."));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Connection test failed."); }
    finally { setBusy(null); }
  }

  function patchPromptTemplate(id: PromptTemplateId, value: string) {
    setPromptOverrides((current) => {
      const next = { ...current };
      if (value === DEFAULT_PROMPT_TEMPLATES[id]) delete next[id];
      else next[id] = value;
      return next;
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand-block"><span className="brand-mark">dp</span><div><h1>dummyplug</h1><p>single-take reference desk · MiniMax H3</p></div></div><div className="top-actions"><span className={`provider-state provider-${settings.provider}`}>{settings.provider}</span><button className="heart-button" onClick={() => setSettingsOpen(true)}><span>♥</span> settings</button></div></header>
      <section className="status-strip" aria-live="polite"><span className={busy ? "pulse-dot" : "status-dot"} /><span>{message}</span><span className="status-metrics">{assets.length} assets · {analyzedCount} analyzed · {chosenAssets.length} selected</span></section>

      <div className="single-grid">
        <aside className="panel library-panel">
          <div className="panel-head"><div><span className="step-index">01</span><h2>asset library</h2></div><span>{assets.length}</span></div>
          <div className={`drop-zone ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}>
            <input ref={fileInputRef} type="file" multiple accept="image/*,video/*,audio/*,.json" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} />
            <button className="drop-picker" onClick={() => void pickReferenceFiles()}><strong>add assets + matching json</strong><span>drop or choose files</span></button>
          </div>
          <div className="source-buttons"><button className="secondary folder-button" onClick={() => void pickReferenceFolder()}>load folder</button><button className="secondary folder-button" disabled={!assets.length} onClick={() => void reloadSources()}>reload sources</button><button className="secondary folder-button analysis-folder-button" onClick={() => void chooseMetadataDirectory()}>{metadataDirectoryName ? `metadata · ${metadataDirectoryName}` : "choose metadata folder"}</button></div>
          <div className="asset-filters"><input value={assetFilterText} onChange={(event) => setAssetFilterText(event.target.value)} placeholder="filter filename or metadata" aria-label="Filter assets by filename or metadata" /><select value={assetFilterKind} onChange={(event) => setAssetFilterKind(event.target.value as "all" | AssetKind)} aria-label="Filter assets by type"><option value="all">all types</option><option value="image">images</option><option value="video">videos</option><option value="audio">audio</option></select></div>
          <div className="asset-database">
            {visibleAssets.map((asset) => { const index = assets.findIndex((candidate) => candidate.id === asset.id); return <article key={asset.id} className={`db-row ${selectedAsset?.id === asset.id ? "active" : ""}`}>
              <button type="button" className="asset-check" title="Include in the current job" aria-pressed={asset.selected} onClick={(event) => { event.stopPropagation(); patchAsset(asset.id, { selected: !asset.selected }); }}><span>{asset.selected ? "✓" : ""}</span></button>
              <button className="db-select" onClick={() => setSelectedAssetId(asset.id)}>
              <div className="db-thumb">{asset.kind === "image" && asset.previewUrl ? <img src={asset.previewUrl} alt="" /> : asset.kind === "video" && asset.previewUrl ? <video src={asset.previewUrl} muted /> : <span>{asset.kind === "audio" ? "♫" : "?"}</span>}<b>{index + 1}</b></div>
              <div className="db-copy"><strong>{asset.canonicalName || asset.name}</strong><span>{asset.role} · {asset.referenceUse} · {asset.analysis ? "vision saved" : "not analyzed"}</span><p>{asset.sourceOf || asset.note || "no source-of authority yet"}</p></div>
              </button>
              <div className="row-order"><button type="button" disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveAsset(asset.id, -1); }} aria-label={`Move ${asset.name} earlier`}>↑</button><button type="button" disabled={index === assets.length - 1} onClick={(event) => { event.stopPropagation(); moveAsset(asset.id, 1); }} aria-label={`Move ${asset.name} later`}>↓</button></div>
              <button className="row-remove" onClick={(event) => { event.stopPropagation(); removeAsset(asset.id); }} aria-label={`Remove ${asset.name}`}>×</button>
            </article>; })}
            {!assets.length ? <p className="empty-copy">Every image, video, and audio file becomes one durable metadata record.</p> : !visibleAssets.length && <p className="empty-copy">No assets match this filter.</p>}
          </div>
        </aside>

        <section className="panel metadata-panel">
          <div className="panel-head"><div><span className="step-index">02</span><h2>asset metadata</h2></div>{selectedAsset && <span>{sidecarName(selectedAsset.name)}</span>}</div>
          {selectedAsset ? <>
            <div className="asset-preview">{selectedAsset.kind === "image" && selectedAsset.previewUrl ? <img src={selectedAsset.previewUrl} alt={selectedAsset.canonicalName || selectedAsset.name} /> : selectedAsset.kind === "video" && selectedAsset.previewUrl ? <video src={selectedAsset.previewUrl} controls /> : selectedAsset.kind === "audio" && selectedAsset.previewUrl ? <audio src={selectedAsset.previewUrl} controls /> : <p>source file not loaded</p>}</div>
            <div className="asset-fileline"><strong>{selectedAsset.name}</strong><span>{humanBytes(selectedAsset.size)} · {selectedAsset.id}</span></div>
            <div className="source-spec"><span>{selectedAsset.sourceWidth && selectedAsset.sourceHeight ? `${selectedAsset.sourceWidth}×${selectedAsset.sourceHeight}` : "dimensions unknown"}</span><span>{selectedAsset.sourceDuration != null ? `${selectedAsset.sourceDuration.toFixed(3)}s` : "duration unknown"}</span><span>{selectedAsset.mimeType}</span></div>
            {selectedAsset.kind === "video" && <div className="trim-controls"><label><span>trim start</span><input type="number" min={0} step={0.001} value={selectedAsset.trimStart ?? 0} onChange={(event) => patchAsset(selectedAsset.id, { trimStart: Number(event.target.value) })} /></label><label><span>trim end</span><input type="number" min={0.001} step={0.001} value={selectedAsset.trimEnd ?? selectedAsset.sourceDuration ?? ""} onChange={(event) => patchAsset(selectedAsset.id, { trimEnd: Number(event.target.value) })} placeholder="seconds" /></label><button type="button" className="secondary" disabled={selectedAsset.sourceDuration == null} onClick={() => patchAsset(selectedAsset.id, { trimStart: 0, trimEnd: selectedAsset.sourceDuration })}>whole source</button>{validateVideoTrim(selectedAsset) && <p>{validateVideoTrim(selectedAsset)}</p>}</div>}
            <label className="meta-field"><span>canonical name</span><input value={selectedAsset.canonicalName} onChange={(event) => patchAsset(selectedAsset.id, { canonicalName: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="Rabbit" /></label>
            <label className="meta-field"><span>role</span><select value={selectedAsset.role} onChange={(event) => patchAsset(selectedAsset.id, { role: event.target.value as AssetRole })} onBlur={() => void saveSelectedMetadata()}>{ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
            <label className="meta-field"><span>H3 use</span><select value={selectedAsset.referenceUse} onChange={(event) => patchAsset(selectedAsset.id, { referenceUse: event.target.value as ReferenceUse })} onBlur={() => void saveSelectedMetadata()}>{REFERENCE_USE_OPTIONS[selectedAsset.kind].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>Subject sources are cited inside a Subject. Picture and Video entries are created only for the explicit structural uses named here.</small></label>
            <label className="meta-field"><span>source of</span><textarea value={selectedAsset.sourceOf} onChange={(event) => patchAsset(selectedAsset.id, { sourceOf: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="face, body, wardrobe, drunken happy expression" /></label>
            <label className="meta-field"><span>your note</span><textarea value={selectedAsset.note} onChange={(event) => patchAsset(selectedAsset.id, { note: event.target.value })} onBlur={() => void saveSelectedMetadata()} placeholder="This is the main character, Rabbit. She's drunk and happy in this reference." /></label>
            <div className="metadata-actions"><button className="primary" disabled={Boolean(busy) || selectedAsset.missingFile || selectedAsset.kind === "audio"} onClick={() => void analyzeSelected()}>{busy === "analyze" ? "analyzing…" : selectedAsset.kind === "audio" ? "manual metadata for audio" : selectedAsset.analysis ? "re-analyze this asset" : "analyze this asset"}</button><button className="secondary" onClick={() => downloadSidecar(selectedAsset)}>download json</button></div>
            {selectedAsset.analysis ? <div className="vision-record"><div className="vision-head"><strong>vision record</strong><span>{selectedAsset.analysis.analysisRole || "general"}</span></div><section><h3>summary</h3><p>{selectedAsset.analysis.summary}</p></section><details open><summary>subjects</summary>{selectedAsset.analysis.subjects.map((item) => <p key={item}>{item}</p>)}</details><details><summary>setting</summary><p>{selectedAsset.analysis.setting}</p></details><details><summary>style</summary><p>{selectedAsset.analysis.style}</p></details><details><summary>composition</summary><p>{selectedAsset.analysis.composition}</p></details><details><summary>motion</summary><p>{selectedAsset.analysis.motion}</p></details><details><summary>continuity locks</summary><ul>{selectedAsset.analysis.continuityLocks.map((item) => <li key={item}>{item}</li>)}</ul></details></div> : <div className="vision-empty"><span>vision is optional and on command</span><p>Your metadata is already usable. Analysis adds visible evidence without replacing it.</p></div>}
          </> : <div className="vision-empty"><span>select an asset</span><p>Its preview, your durable tags, and the vision record appear here.</p></div>}
        </section>

        <aside className="panel prompt-panel-single">
          <div className="panel-head"><div><span className="step-index">03</span><h2>one continuous take</h2></div><span className={validation ? validation.valid ? "validation-ok" : "validation-bad" : "validation-pending"}>{validation ? validation.valid ? "single take valid" : "needs repair" : "not generated"}</span></div>
          <label className="simple-prompt"><span>simple prompt</span><textarea value={simplePrompt} onChange={(event) => setSimplePrompt(event.target.value)} placeholder="Rabbit and her friend walk from left to right through the attached landscape." /></label>
          <div className="duration-row"><label>duration <input type="number" min={1} max={20} value={durationSeconds} onChange={(event) => setDurationSeconds(Math.max(1, Math.min(20, Number(event.target.value) || 10)))} /> seconds</label><strong>one shot · no cuts</strong></div>
          <div className="task-prefix">[{compiled.taskTypes.join(" + ") || "reference generation"}]</div>
          <div className="attachment-list"><div><strong>resolved subjects + reference labels</strong><span>{compiled.subjects.length} · {compiled.attachments.length}</span></div>{compiled.subjects.map((subject) => <p className="subject-map-row" key={subject.label}><b>{subject.label}</b><span>{subject.canonicalName}</span><em>{subject.attachmentLabels.join(" + ")}</em></p>)}{compiled.attachments.map((attachment) => { const asset = assets.find((item) => item.id === attachment.assetId)!; return <p key={attachment.assetId}><b>{attachment.label}</b><span>{attachment.standaloneEntry ? "standalone entry" : "inside Subject only"}</span><em>{asset.sourceOf || asset.role}</em></p>; })}{!compiled.attachments.length && <p className="attachment-empty">Check assets in the library.</p>}</div>
          {compiled.warnings.length > 0 && <div className="warning-box">{compiled.warnings.map((warning) => <p key={warning}>△ {warning}</p>)}</div>}
          <button className="primary generate-single" disabled={Boolean(busy) || !simplePrompt.trim() || !chosenAssets.length} onClick={() => void generatePrompt()}>{busy === "generate" ? "writing one continuous take…" : "generate six-part prompt"}</button>
          {promptHistory.length > 0 && <label className="prompt-history"><span>recent generated versions</span><select value="" onChange={(event) => { const remembered = promptHistory[Number(event.target.value)]; if (remembered) setGeneratedPrompt(remembered); }}><option value="" disabled>restore one of the last {promptHistory.length}</option>{promptHistory.map((prompt, index) => <option value={index} key={`${index}-${prompt.slice(0, 24)}`}>version {index + 1} · {prompt.replace(/\s+/g, " ").slice(0, 52)}</option>)}</select></label>}
          <textarea className="prompt-output single-output" value={generatedPrompt} onChange={(event) => setGeneratedPrompt(event.target.value)} placeholder="The expanded six-part H3 prompt appears here. It will contain exactly one [Shot 1]." spellCheck={false} />
          <details className="job-controls" open><summary>job seal settings <span>{jobSettings.width}×{jobSettings.height} · {jobSettings.fps} fps</span></summary><div className="preset-row"><button type="button" onClick={() => patchJobSettings({ width: 768, height: 1344 })}>portrait</button><button type="button" onClick={() => patchJobSettings({ width: 1344, height: 768 })}>landscape</button><button type="button" onClick={() => patchJobSettings({ width: 1024, height: 1024 })}>square</button></div><div className="job-control-grid">
            <label className="wide"><span>job title</span><input value={jobSettings.title} onChange={(event) => patchJobSettings({ title: event.target.value })} placeholder="optional" /></label>
            <label><span>width</span><input type="number" min={64} max={8192} value={jobSettings.width} onChange={(event) => patchJobSettings({ width: Number(event.target.value) })} /></label><label><span>height</span><input type="number" min={64} max={8192} value={jobSettings.height} onChange={(event) => patchJobSettings({ height: Number(event.target.value) })} /></label>
            <label><span>fps</span><input type="number" min={1} max={120} value={jobSettings.fps} onChange={(event) => patchJobSettings({ fps: Number(event.target.value) })} /></label><label><span>steps</span><input type="number" min={1} max={200} value={jobSettings.steps} onChange={(event) => patchJobSettings({ steps: Number(event.target.value) })} /></label>
            <label className="wide seed-control"><span>seed</span><input type="number" min={0} max={Number.MAX_SAFE_INTEGER} value={jobSettings.seed} onChange={(event) => patchJobSettings({ seed: Number(event.target.value) })} /><button type="button" onClick={() => patchJobSettings({ seed: randomSeed() })}>randomize</button></label>
            <label className="wide"><span>sampler</span><input value={jobSettings.sampler} onChange={(event) => patchJobSettings({ sampler: event.target.value })} /></label>
            <label><span>shift video</span><input type="number" step={0.1} value={jobSettings.shiftVideo} onChange={(event) => patchJobSettings({ shiftVideo: Number(event.target.value) })} /></label><label><span>shift audio</span><input type="number" step={0.1} value={jobSettings.shiftAudio} onChange={(event) => patchJobSettings({ shiftAudio: Number(event.target.value) })} /></label>
            <label><span>input scaling</span><select value={jobSettings.inputScaling} onChange={(event) => patchJobSettings({ inputScaling: event.target.value })}><option value="match">match</option><option value="fit">fit</option><option value="fill">fill</option><option value="native">native</option><option value="720">720px</option><option value="1024">1024px</option></select></label><label><span>workflow</span><select value={jobSettings.workflowPreset} onChange={(event) => patchJobSettings({ workflowPreset: event.target.value as JobSettings["workflowPreset"] })}><option value="dasiwa-ref2va:v1">dasiwa-ref2va:v1</option></select></label>
            <label><span>container</span><select value={jobSettings.outputContainer} onChange={(event) => patchJobSettings({ outputContainer: event.target.value })}><option>Auto</option><option>mp4</option><option>mov</option><option>mkv</option></select></label><label><span>codec</span><select value={jobSettings.outputCodec} onChange={(event) => patchJobSettings({ outputCodec: event.target.value })}><option>Auto</option><option>h264</option><option>hevc</option><option>prores</option></select></label>
            <label title="Video encoder CRF/CQ. Lower values preserve more quality and produce larger files."><span>video quality (CRF/CQ)</span><input type="number" min={0} max={51} value={jobSettings.outputQuality} onChange={(event) => patchJobSettings({ outputQuality: Number(event.target.value) })} /></label><label><span>audio codec</span><select value={jobSettings.audioCodec} onChange={(event) => patchJobSettings({ audioCodec: event.target.value })}><option>Auto</option><option>aac</option><option>opus</option><option>pcm_s16le</option></select></label>
            <label className="wide"><span>audio bitrate</span><select value={jobSettings.audioBitrate} onChange={(event) => patchJobSettings({ audioBitrate: event.target.value })}><option>96k</option><option>128k</option><option>192k</option><option>256k</option><option>320k</option></select></label>
          </div></details>
          <div className={`seal-feedback ${sealIssues.length ? "error" : sealFeedback ? "active" : "ready"}`} aria-live="polite">{sealIssues.length ? sealIssues[0] : sealFeedback || "Ready to hash and seal this immutable job."}</div>
          <div className="single-actions"><button className="secondary" disabled={!generatedPrompt} onClick={() => void navigator.clipboard.writeText(generatedPrompt).then(() => setMessage("Prompt copied."))}>copy prompt</button><button className="primary" disabled={!generatedPrompt || busy === "export"} onClick={() => void sealBundle()}>{busy === "export" ? "hashing + sealing…" : "seal job zip"}</button></div>
        </aside>
      </div>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-sheet" role="dialog" aria-modal="true"><div className="settings-head"><div><span className="heart-large">♥</span><div><h2>{settingsPage === "connection" ? "model connections" : "system prompts"}</h2><p>{settingsPage === "connection" ? "Two models: vision metadata and prompt expansion." : "The exact recipes used by this reduced workflow."}</p></div></div><button onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button></div><nav className="inline-settings-tabs"><button className={settingsPage === "connection" ? "active" : ""} onClick={() => setSettingsPage("connection")}>connection</button><button className={settingsPage === "prompts" ? "active" : ""} onClick={() => setSettingsPage("prompts")}>prompts</button></nav>{settingsPage === "connection" ? <>
        <div className={`settings-status ${busy ? "active" : ""}`} aria-live="polite"><strong>{busy === "test" ? "testing OpenRouter…" : busy ? "request running…" : "provider status"}</strong><p>{message}</p></div>
        <label className="field"><span>provider</span><select value={settings.provider} onChange={(event) => setSettings({ ...settings, provider: event.target.value as ModelSettings["provider"] })}><option value="demo">offline demo</option><option value="openrouter">OpenRouter</option><option value="local">local OpenAI-compatible server</option></select></label>
        {settings.provider === "local" && <label className="field"><span>server address</span><input value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>}
        <label className="field"><span>vision model</span><input disabled={settings.provider === "demo"} value={settings.visionModel} onChange={(event) => setSettings({ ...settings, visionModel: event.target.value })} /></label>
        <label className="field"><span>prompt model</span><input disabled={settings.provider === "demo"} value={settings.promptModel} onChange={(event) => setSettings({ ...settings, promptModel: event.target.value })} /></label>
        <label className="field"><span>prompt output tokens</span><input type="number" min={8192} max={32768} step={4096} disabled={settings.provider === "demo"} value={settings.promptMaxTokens} onChange={(event) => setSettings({ ...settings, promptMaxTokens: Math.max(8192, Math.min(32768, Number(event.target.value) || 32768)) })} /></label>
        {settings.provider !== "demo" && <label className="field"><span>api key</span><input type="password" value={settings.apiKey} onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })} autoComplete="off" /></label>}
        {settings.provider !== "demo" && <label className="check-field"><input type="checkbox" checked={settings.rememberKey} onChange={(event) => setSettings({ ...settings, rememberKey: event.target.checked })} /><span>remember key in this browser profile</span></label>}
        <label className="field"><span>temperature <output>{settings.temperature.toFixed(1)}</output></span><input type="range" min="0" max="1" step="0.1" disabled={settings.provider === "demo"} value={settings.temperature} onChange={(event) => setSettings({ ...settings, temperature: Number(event.target.value) })} /></label>
        <div className="settings-actions"><button className="secondary" onClick={() => setSettings(DEFAULT_SETTINGS)}>reset models</button><button className="secondary request-reset" onClick={cancelRequest}>{busy ? "cancel request" : "reset request"}</button><button className="secondary" disabled={Boolean(busy)} onClick={() => void testProvider()}>{busy === "test" ? "testing…" : "test"}</button><button className="primary" onClick={() => setSettingsOpen(false)}>done</button></div>
      </> : <><div className="prompt-registry-intro"><strong>DaSiWa single-take recipes</strong><p>Vision recipes create durable asset evidence. The final recipe applies the official full-reference label roles while expanding one request into one uninterrupted take.</p><button className="secondary" onClick={() => setPromptOverrides({})}>reset to defaults</button></div><div className="prompt-registry">{EXPOSED_PROMPT_TEMPLATES.map((item) => <article className="system-prompt-card" key={item.id}><div className="system-prompt-head"><div><h3>{item.title}</h3><span>{item.modelRole}</span></div><button className="secondary" onClick={() => { void navigator.clipboard.writeText(promptOverrides[item.id] ?? item.template); setCopiedPromptId(item.id); window.setTimeout(() => setCopiedPromptId(null), 1200); }}>{copiedPromptId === item.id ? "copied" : "copy"}</button></div><p>{item.description}</p><textarea value={promptOverrides[item.id] ?? item.template} onChange={(event) => patchPromptTemplate(item.id, event.target.value)} spellCheck={false} /></article>)}</div></>}
      </section></div>}
    </main>
  );
}
