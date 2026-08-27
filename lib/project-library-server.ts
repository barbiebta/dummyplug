import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_DRAFT, DEFAULT_PROJECT_OUTPUT_SETTINGS, PROJECT_ASSET_SIDECAR_SUFFIX, PROJECT_DRAFT_SCHEMA, PROJECT_SCHEMA, projectSidecarPath } from "./project-contract.ts";
import type { ProjectAsset, ProjectAssetMetadata, ProjectAssetSidecar, ProjectDraft, ProjectManifest, ProjectOutputSettings } from "./project-contract.ts";

export const DEFAULT_PROJECT_LIBRARY_ROOT = "D:\\dummyplug libraries\\";
const ASSETS_DIRECTORY = "assets";
const TRASH_DIRECTORY = ".trash";
const PROJECT_FILE = "project.json";
const DRAFT_FILE = "draft-job.json";
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const VALID_ROLES = new Set(["character", "setting", "style", "motion", "prop", "audio", "general"]);
const VALID_REFERENCE_USES = new Set(["subject", "frame-anchor", "video-structure", "video-edit", "video-continuation", "audio-reference", "audio-copy"]);

export class ProjectLibraryError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProjectLibraryError";
    this.status = status;
  }
}

export interface ImportAssetInput {
  relativePath: string;
  bytes: Uint8Array | ArrayBuffer | Buffer;
  mimeType?: string;
  lastModified?: number;
  /** Optional pre-existing authored sidecar. Project bookkeeping is regenerated. */
  sidecar?: string | Record<string, unknown>;
}

export interface ImportAssetResult extends ProjectAsset {
  conflictRenamed: boolean;
}

function now() { return new Date().toISOString(); }

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function contentHash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assetKind(name: string): ProjectAsset["kind"] {
  const extension = path.posix.extname(name).toLocaleLowerCase();
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"].includes(extension)) return "audio";
  return "image";
}

function mimeFromName(name: string) {
  const extension = path.posix.extname(name).toLocaleLowerCase();
  const types: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm", ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".m4a": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
  };
  return types[extension] || "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanOutputSettings(value: unknown): ProjectOutputSettings {
  const raw = isRecord(value) ? value : {};
  const fromRaw = <T extends keyof ProjectOutputSettings>(key: T) => raw[key] ?? DEFAULT_PROJECT_OUTPUT_SETTINGS[key];
  return {
    defaultsVersion: DEFAULT_PROJECT_OUTPUT_SETTINGS.defaultsVersion,
    width: Number(fromRaw("width")), height: Number(fromRaw("height")), fps: Number(fromRaw("fps")), steps: Number(fromRaw("steps")),
    shiftVideo: Number(fromRaw("shiftVideo")), shiftAudio: Number(fromRaw("shiftAudio")), outputQuality: Number(fromRaw("outputQuality")),
    sampler: String(fromRaw("sampler")), outputContainer: String(fromRaw("outputContainer")), outputCodec: String(fromRaw("outputCodec")),
    audioCodec: String(fromRaw("audioCodec")), audioBitrate: String(fromRaw("audioBitrate")),
    refImageSize: fromRaw("refImageSize") === "match" ? "match" : "max",
    inputScaling: String(fromRaw("inputScaling")) as ProjectOutputSettings["inputScaling"],
    workflowPreset: "dasiwa-ref2va:v1",
  };
}

function cleanDraft(projectId: string, value: unknown): ProjectDraft {
  const raw = isRecord(value) ? value : {};
  const selected = Array.isArray(raw.selectedAssetIds) ? raw.selectedAssetIds.map(String) : [];
  const history = Array.isArray(raw.generatedPromptHistory) ? raw.generatedPromptHistory.map(String).slice(0, 5) : [];
  return {
    schema: PROJECT_DRAFT_SCHEMA,
    projectId,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now(),
    simplePrompt: typeof raw.simplePrompt === "string" ? raw.simplePrompt : "",
    jobDesc: typeof raw.jobDesc === "string" ? raw.jobDesc.slice(0, 30) : "",
    selectedAssetIds: [...new Set(selected)],
    duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : DEFAULT_PROJECT_DRAFT.duration,
    seedMode: raw.seedMode === "random" ? "random" : "fixed",
    fixedSeed: Number.isSafeInteger(raw.fixedSeed) && Number(raw.fixedSeed) >= 0 ? Number(raw.fixedSeed) : DEFAULT_PROJECT_DRAFT.fixedSeed,
    generatedPrompt: typeof raw.generatedPrompt === "string" ? raw.generatedPrompt : "",
    generatedPromptHistory: history,
  };
}

function safeProjectName(name: string) {
  const trimmed = name.trim();
  if (!PROJECT_NAME.test(trimmed) || trimmed.endsWith(".") || trimmed.endsWith(" ") || WINDOWS_RESERVED_NAME.test(trimmed)) {
    throw new ProjectLibraryError("Project names may contain letters, numbers, spaces, hyphens, and underscores only.");
  }
  return trimmed;
}

/**
 * A node-only, framework-agnostic local project library. The web app speaks to
 * it through Vite middleware; it must never be imported into browser code.
 */
export class ProjectLibrary {
  readonly root: string;

  constructor(root = process.env.DUMMYPLUG_LIBRARY_ROOT || DEFAULT_PROJECT_LIBRARY_ROOT) {
    this.root = path.resolve(root);
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    const rootStats = await fs.lstat(this.root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new ProjectLibraryError("Project library root is not a real directory.", 500);
  }

  private rejectUnsafeRelative(relativePath: string) {
    if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) throw new ProjectLibraryError("A relative path is required.");
    const normalized = relativePath.replaceAll("\\", "/");
    if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(normalized)) throw new ProjectLibraryError("Absolute paths are not allowed.");
    const parts = normalized.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw new ProjectLibraryError("Path traversal is not allowed.");
    return parts.join("/");
  }

  private async assertNoSymlinkPath(target: string, allowMissingLeaf = false) {
    const relative = path.relative(this.root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ProjectLibraryError("Path escapes the project library.");
    const segments = relative.split(path.sep).filter(Boolean);
    let cursor = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]);
      try {
        const entry = await fs.lstat(cursor);
        if (entry.isSymbolicLink()) throw new ProjectLibraryError("Symbolic links are not allowed in a project library.");
      } catch (error) {
        if (isNodeError(error, "ENOENT") && allowMissingLeaf) return;
        throw error;
      }
    }
  }

  private async writeJson(filePath: string, value: unknown) {
    await this.assertNoSymlinkPath(filePath, true);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${randomUUID()}`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  }

  private async readJson(filePath: string): Promise<unknown | null> {
    await this.assertNoSymlinkPath(filePath, true);
    try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
    catch (error) { if (isNodeError(error, "ENOENT")) return null; throw error; }
  }

  private async projectDirectory(projectId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new ProjectLibraryError("Invalid project ID.");
    const projects = await this.listProjects();
    const found = projects.find((project) => project.id === projectId);
    if (!found) throw new ProjectLibraryError("Project was not found.", 404);
    const directory = path.join(this.root, found.name);
    await this.assertNoSymlinkPath(directory);
    return directory;
  }

  private assetsPath(projectDirectory: string, relativePath = "") {
    const safe = relativePath ? this.rejectUnsafeRelative(relativePath) : "";
    return path.join(projectDirectory, ASSETS_DIRECTORY, ...safe.split("/").filter(Boolean));
  }

  /** Safe absolute resolution for Vite's media/sidecar route only. */
  async resolveAssetPath(projectId: string, relativePath: string) {
    return (await this.existingAssetPath(projectId, relativePath)).assetPath;
  }

  /** Safe absolute resolution for writing or reading an asset's companion sidecar. */
  async resolveSidecarPath(projectId: string, relativePath: string) {
    const assetPath = await this.resolveAssetPath(projectId, relativePath);
    return `${assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`;
  }

  async listProjects(): Promise<ProjectManifest[]> {
    await this.initialize();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const projects: ProjectManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(this.root, entry.name);
      await this.assertNoSymlinkPath(directory);
      const raw = await this.readJson(path.join(directory, PROJECT_FILE));
      if (!isRecord(raw) || raw.schema !== PROJECT_SCHEMA || typeof raw.id !== "string" || typeof raw.name !== "string") continue;
      projects.push({
        schema: PROJECT_SCHEMA, id: raw.id, name: raw.name, createdAt: String(raw.createdAt || ""), updatedAt: String(raw.updatedAt || ""),
        outputSettings: cleanOutputSettings(raw.outputSettings),
      });
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
  }

  async createProject(name: string): Promise<ProjectManifest> {
    await this.initialize();
    const safeName = safeProjectName(name);
    const directory = path.join(this.root, safeName);
    await this.assertNoSymlinkPath(directory, true);
    try { await fs.access(directory); throw new ProjectLibraryError(`A project named “${safeName}” already exists.`, 409); }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
    await fs.mkdir(path.join(directory, ASSETS_DIRECTORY), { recursive: true });
    await fs.mkdir(path.join(directory, TRASH_DIRECTORY), { recursive: true });
    const createdAt = now();
    const manifest: ProjectManifest = { schema: PROJECT_SCHEMA, id: randomUUID(), name: safeName, createdAt, updatedAt: createdAt, outputSettings: clone(DEFAULT_PROJECT_OUTPUT_SETTINGS) };
    await this.writeJson(path.join(directory, PROJECT_FILE), manifest);
    await this.writeJson(path.join(directory, DRAFT_FILE), { schema: PROJECT_DRAFT_SCHEMA, projectId: manifest.id, updatedAt: createdAt, ...clone(DEFAULT_PROJECT_DRAFT) });
    return manifest;
  }

  async getProject(projectId: string): Promise<ProjectManifest> {
    const directory = await this.projectDirectory(projectId);
    const raw = await this.readJson(path.join(directory, PROJECT_FILE));
    if (!isRecord(raw)) throw new ProjectLibraryError("Project manifest is unreadable.", 500);
    return { schema: PROJECT_SCHEMA, id: String(raw.id), name: String(raw.name), createdAt: String(raw.createdAt), updatedAt: String(raw.updatedAt), outputSettings: cleanOutputSettings(raw.outputSettings) };
  }

  async updateProject(projectId: string, changes: { name?: string; outputSettings?: Partial<ProjectOutputSettings> }) {
    const directory = await this.projectDirectory(projectId);
    const current = await this.getProject(projectId);
    let name = current.name;
    let nextDirectory = directory;
    if (changes.name != null) {
      name = safeProjectName(changes.name);
      nextDirectory = path.join(this.root, name);
      if (nextDirectory !== directory) {
        try { await fs.access(nextDirectory); throw new ProjectLibraryError(`A project named “${name}” already exists.`, 409); }
        catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
        await fs.rename(directory, nextDirectory);
      }
    }
    const manifest: ProjectManifest = {
      ...current, name, updatedAt: now(),
      outputSettings: cleanOutputSettings({ ...current.outputSettings, ...(changes.outputSettings || {}) }),
    };
    await this.writeJson(path.join(nextDirectory, PROJECT_FILE), manifest);
    return manifest;
  }

  async getDraft(projectId: string): Promise<ProjectDraft> {
    const directory = await this.projectDirectory(projectId);
    return cleanDraft(projectId, await this.readJson(path.join(directory, DRAFT_FILE)));
  }

  async updateDraft(projectId: string, changes: Partial<Omit<ProjectDraft, "schema" | "projectId" | "updatedAt">>) {
    const directory = await this.projectDirectory(projectId);
    const current = await this.getDraft(projectId);
    const draft = cleanDraft(projectId, { ...current, ...changes, updatedAt: now() });
    await this.writeJson(path.join(directory, DRAFT_FILE), draft);
    return draft;
  }

  private async readAssetSidecar(sidecarPath: string): Promise<ProjectAssetSidecar | null> {
    const raw = await this.readJson(sidecarPath);
    return isRecord(raw) ? raw as ProjectAssetSidecar : null;
  }

  private async writeAssetSidecar(projectDirectory: string, relativePath: string, input: { id?: string; importedAt?: string; mimeType: string; size: number; lastModified: number; sha256?: string; existing?: unknown }) {
    const assetPath = this.assetsPath(projectDirectory, relativePath);
    const sidecarPath = `${assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`;
    const existing = isRecord(input.existing) ? clone(input.existing) : {};
    const v4CompatibleExisting = { ...existing };
    delete v4CompatibleExisting.dummyplug;
    const oldSource = isRecord(existing.source) ? existing.source : {};
    const bytesChanged = typeof oldSource.sha256 === "string" && typeof input.sha256 === "string" && oldSource.sha256 !== input.sha256;
    const assetId = input.id || randomUUID();
    const sidecar: ProjectAssetSidecar = {
      ...v4CompatibleExisting,
      schema: "dummyplug.asset.v4",
      assetId,
      relativePath,
      importedAt: input.importedAt || now(),
      source: { ...oldSource, name: path.posix.basename(relativePath), size: input.size, mimeType: input.mimeType, lastModified: input.lastModified, ...(input.sha256 ? { sha256: input.sha256 } : {}) },
      ...(isRecord(existing.analysis) && !bytesChanged ? { analysis: { ...existing.analysis, assetId } } : {}),
      ...(isRecord(existing.localAnalysis) && !bytesChanged ? { localAnalysis: { ...existing.localAnalysis, assetId } } : {}),
      ...(bytesChanged ? { analysis: undefined, localAnalysis: undefined } : {}),
      updatedAt: now(),
    };
    await this.writeJson(sidecarPath, sidecar);
    return sidecar;
  }

  private async destinationWithoutConflict(projectDirectory: string, desiredRelativePath: string) {
    const safe = this.rejectUnsafeRelative(desiredRelativePath);
    const parsed = path.posix.parse(safe);
    for (let number = 1; number < 10_000; number += 1) {
      const candidate = number === 1 ? safe : path.posix.join(parsed.dir, `${parsed.name} (${number})${parsed.ext}`);
      try { await fs.access(this.assetsPath(projectDirectory, candidate)); }
      catch (error) { if (isNodeError(error, "ENOENT")) return { relativePath: candidate, conflictRenamed: number > 1 }; throw error; }
    }
    throw new ProjectLibraryError("Could not find a non-conflicting filename.", 409);
  }

  async importAsset(projectId: string, input: ImportAssetInput): Promise<ImportAssetResult> {
    const directory = await this.projectDirectory(projectId);
    const requestedPath = this.rejectUnsafeRelative(input.relativePath);
    if (requestedPath.endsWith(PROJECT_ASSET_SIDECAR_SUFFIX)) throw new ProjectLibraryError("Sidecars cannot be imported as assets.");
    const resolved = await this.destinationWithoutConflict(directory, requestedPath);
    const destination = this.assetsPath(directory, resolved.relativePath);
    await this.assertNoSymlinkPath(destination, true);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const bytes = input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : new Uint8Array(input.bytes);
    await fs.writeFile(destination, bytes);
    const stats = await fs.stat(destination);
    let existing: unknown = undefined;
    if (typeof input.sidecar === "string") {
      try { existing = JSON.parse(input.sidecar); } catch { throw new ProjectLibraryError("Imported sidecar is not valid JSON."); }
    } else existing = input.sidecar;
    const sidecar = await this.writeAssetSidecar(directory, resolved.relativePath, { mimeType: input.mimeType || mimeFromName(resolved.relativePath), size: stats.size, lastModified: Number(input.lastModified || stats.mtimeMs), sha256: contentHash(bytes), existing });
    const asset = this.toAsset(resolved.relativePath, stats, sidecar);
    return { ...asset, conflictRenamed: resolved.conflictRenamed };
  }

  private toAsset(relativePath: string, stats: { size: number; mtimeMs: number; birthtimeMs: number }, sidecar: ProjectAssetSidecar): ProjectAsset {
    const source = sidecar.source as unknown as Record<string, unknown>;
    const nested = isRecord(sidecar.dummyplug) ? sidecar.dummyplug : {};
    const rawMetadata = isRecord(sidecar.metadata) ? sidecar.metadata : {};
    const metadata: ProjectAssetMetadata = {
      ...rawMetadata,
      canonicalName: typeof rawMetadata.canonicalName === "string" ? rawMetadata.canonicalName : "",
      role: VALID_ROLES.has(String(rawMetadata.role)) ? String(rawMetadata.role) as ProjectAssetMetadata["role"] : "general",
      referenceUse: VALID_REFERENCE_USES.has(String(rawMetadata.referenceUse)) ? String(rawMetadata.referenceUse) as ProjectAssetMetadata["referenceUse"] : "subject",
      sourceOf: typeof rawMetadata.sourceOf === "string" ? rawMetadata.sourceOf : "",
      note: typeof rawMetadata.note === "string" ? rawMetadata.note : "",
      localSourceOf: typeof rawMetadata.localSourceOf === "string" ? rawMetadata.localSourceOf : "",
      localNote: typeof rawMetadata.localNote === "string" ? rawMetadata.localNote : "",
    };
    return {
      id: typeof sidecar.assetId === "string" ? sidecar.assetId : typeof nested.assetId === "string" ? nested.assetId : randomUUID(),
      relativePath,
      name: path.posix.basename(relativePath),
      kind: assetKind(relativePath), size: stats.size,
      mimeType: typeof source.mimeType === "string" ? source.mimeType : mimeFromName(relativePath),
      lastModified: Number(source.lastModified || stats.mtimeMs),
      importedAt: typeof sidecar.importedAt === "string" ? sidecar.importedAt : typeof nested.importedAt === "string" ? nested.importedAt : new Date(stats.birthtimeMs || stats.mtimeMs).toISOString(),
      ...(typeof source.width === "number" ? { sourceWidth: source.width } : {}),
      ...(typeof source.height === "number" ? { sourceHeight: source.height } : {}),
      ...(typeof source.duration === "number" ? { sourceDuration: source.duration } : {}),
      ...(typeof source.sha256 === "string" ? { sha256: source.sha256 } : {}),
      canonicalName: metadata.canonicalName, role: metadata.role, referenceUse: metadata.referenceUse, sourceOf: metadata.sourceOf, note: metadata.note,
      localSourceOf: metadata.localSourceOf, localNote: metadata.localNote,
      metadata,
      analysis: isRecord(sidecar.analysis) ? sidecar.analysis : undefined,
      localAnalysis: isRecord(sidecar.localAnalysis) ? sidecar.localAnalysis : undefined,
      sidecarPath: projectSidecarPath(relativePath),
    };
  }

  async recrawl(projectId: string): Promise<ProjectAsset[]> {
    const directory = await this.projectDirectory(projectId);
    const assetsDirectory = this.assetsPath(directory);
    await fs.mkdir(assetsDirectory, { recursive: true });
    const discovered: ProjectAsset[] = [];
    const visit = async (absoluteDirectory: string, relativeDirectory = "") => {
      await this.assertNoSymlinkPath(absoluteDirectory);
      const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const absolutePath = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) { await visit(absolutePath, relativePath); continue; }
        if (entry.isFile() && entry.name.includes(`${PROJECT_ASSET_SIDECAR_SUFFIX}.tmp-`)) {
          await fs.rm(absolutePath, { force: true });
          await fs.rm(`${absolutePath}${PROJECT_ASSET_SIDECAR_SUFFIX}`, { force: true });
          continue;
        }
        if (!entry.isFile() || entry.name.endsWith(PROJECT_ASSET_SIDECAR_SUFFIX)) continue;
        const stats = await fs.stat(absolutePath);
        const sha256 = contentHash(await fs.readFile(absolutePath));
        const existing = await this.readAssetSidecar(`${absolutePath}${PROJECT_ASSET_SIDECAR_SUFFIX}`);
        const sidecar = await this.writeAssetSidecar(directory, relativePath, {
          id: existing?.assetId || existing?.dummyplug?.assetId, importedAt: existing?.importedAt || existing?.dummyplug?.importedAt,
          mimeType: typeof existing?.source?.mimeType === "string" ? existing.source.mimeType : mimeFromName(relativePath),
          size: stats.size, lastModified: stats.mtimeMs, sha256, existing,
        });
        discovered.push(this.toAsset(relativePath, stats, sidecar));
      }
    };
    await visit(assetsDirectory);
    return discovered.sort((left, right) => right.importedAt.localeCompare(left.importedAt) || right.relativePath.localeCompare(left.relativePath));
  }

  async listFolders(projectId: string): Promise<string[]> {
    const directory = await this.projectDirectory(projectId);
    const assetsDirectory = this.assetsPath(directory);
    await fs.mkdir(assetsDirectory, { recursive: true });
    const folders: string[] = [];
    const visit = async (absoluteDirectory: string, relativeDirectory = "") => {
      await this.assertNoSymlinkPath(absoluteDirectory);
      const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        folders.push(relativePath);
        await visit(path.join(absoluteDirectory, entry.name), relativePath);
      }
    };
    await visit(assetsDirectory);
    return folders.sort((left, right) => left.localeCompare(right));
  }

  async createFolder(projectId: string, relativePath: string) {
    const directory = await this.projectDirectory(projectId);
    const destination = this.assetsPath(directory, relativePath);
    await this.assertNoSymlinkPath(destination, true);
    await fs.mkdir(destination, { recursive: false });
  }

  private async existingFolderPath(projectId: string, relativePath: string) {
    const directory = await this.projectDirectory(projectId);
    const safeRelativePath = this.rejectUnsafeRelative(relativePath);
    const folderPath = this.assetsPath(directory, safeRelativePath);
    await this.assertNoSymlinkPath(folderPath);
    const stats = await fs.lstat(folderPath);
    if (!stats.isDirectory()) throw new ProjectLibraryError("Folder was not found.", 404);
    return { directory, folderPath, safeRelativePath };
  }

  async moveFolder(projectId: string, relativePath: string, destinationFolder: string) {
    const source = await this.existingFolderPath(projectId, relativePath);
    const destination = destinationFolder ? this.rejectUnsafeRelative(destinationFolder) : "";
    if (destination === source.safeRelativePath || destination.startsWith(`${source.safeRelativePath}/`)) throw new ProjectLibraryError("A folder cannot be moved into itself.");
    const destinationParent = this.assetsPath(source.directory, destination);
    await this.assertNoSymlinkPath(destinationParent);
    const targetRelative = destination ? `${destination}/${path.posix.basename(source.safeRelativePath)}` : path.posix.basename(source.safeRelativePath);
    const target = this.assetsPath(source.directory, targetRelative);
    try { await fs.access(target); throw new ProjectLibraryError("A folder with that name already exists.", 409); }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
    await fs.rename(source.folderPath, target);
  }

  async renameFolder(projectId: string, relativePath: string, newName: string) {
    const source = await this.existingFolderPath(projectId, relativePath);
    const safeName = this.rejectUnsafeRelative(newName);
    if (safeName.includes("/")) throw new ProjectLibraryError("A folder name cannot contain path separators.");
    const parent = path.posix.dirname(source.safeRelativePath);
    const targetRelative = parent === "." ? safeName : `${parent}/${safeName}`;
    const target = this.assetsPath(source.directory, targetRelative);
    try { await fs.access(target); throw new ProjectLibraryError("A folder with that name already exists.", 409); }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
    await fs.rename(source.folderPath, target);
  }

  /**
   * Durable metadata/analysis update used by both manual editing and vision
   * analysis. It leaves source bytes and the stable v4 asset identity intact.
   */
  async updateAssetMetadata(projectId: string, relativePath: string, changes: {
    metadata?: Partial<ProjectAssetMetadata>;
    analysis?: Record<string, unknown> | undefined;
    localAnalysis?: Record<string, unknown> | undefined;
    sourceFacts?: Record<string, unknown>;
  }) {
    const source = await this.existingAssetPath(projectId, relativePath);
    const stats = await fs.stat(source.assetPath);
    const existing = await this.readAssetSidecar(`${source.assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`);
    const current = existing || await this.writeAssetSidecar(source.directory, source.safeRelativePath, {
      mimeType: mimeFromName(source.safeRelativePath), size: stats.size, lastModified: stats.mtimeMs,
    });
    const nextMetadata = { ...(isRecord(current.metadata) ? current.metadata : {}), ...(changes.metadata || {}) };
    const nextSource = { ...(isRecord(current.source) ? current.source : {}), ...(changes.sourceFacts || {}) };
    const sidecar = await this.writeAssetSidecar(source.directory, source.safeRelativePath, {
      id: current.assetId || current.dummyplug?.assetId,
      importedAt: current.importedAt || current.dummyplug?.importedAt,
      mimeType: typeof nextSource.mimeType === "string" ? nextSource.mimeType : mimeFromName(source.safeRelativePath),
      size: stats.size,
      lastModified: Number(nextSource.lastModified || stats.mtimeMs),
      existing: { ...current, metadata: nextMetadata, ...(changes.analysis === undefined ? {} : { analysis: changes.analysis }), ...(changes.localAnalysis === undefined ? {} : { localAnalysis: changes.localAnalysis }), source: nextSource },
    });
    return this.toAsset(source.safeRelativePath, stats, sidecar);
  }

  private async existingAssetPath(projectId: string, relativePath: string) {
    const directory = await this.projectDirectory(projectId);
    const assetPath = this.assetsPath(directory, relativePath);
    await this.assertNoSymlinkPath(assetPath);
    const stats = await fs.lstat(assetPath);
    if (!stats.isFile()) throw new ProjectLibraryError("Asset was not found.", 404);
    return { directory, assetPath, safeRelativePath: this.rejectUnsafeRelative(relativePath) };
  }

  async moveAsset(projectId: string, relativePath: string, destinationFolder: string) {
    const source = await this.existingAssetPath(projectId, relativePath);
    const folder = destinationFolder ? this.rejectUnsafeRelative(destinationFolder) : "";
    const destinationFolderPath = this.assetsPath(source.directory, folder);
    await this.assertNoSymlinkPath(destinationFolderPath);
    const candidate = folder ? `${folder}/${path.posix.basename(source.safeRelativePath)}` : path.posix.basename(source.safeRelativePath);
    if (candidate === source.safeRelativePath) {
      const stats = await fs.stat(source.assetPath);
      const sidecar = await this.readAssetSidecar(`${source.assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`);
      return this.toAsset(source.safeRelativePath, stats, sidecar || await this.writeAssetSidecar(source.directory, source.safeRelativePath, { mimeType: mimeFromName(source.safeRelativePath), size: stats.size, lastModified: stats.mtimeMs }));
    }
    const destination = await this.destinationWithoutConflict(source.directory, candidate);
    const destinationPath = this.assetsPath(source.directory, destination.relativePath);
    await fs.rename(source.assetPath, destinationPath);
    const sourceSidecar = `${source.assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`;
    const sidecar = await this.readAssetSidecar(sourceSidecar);
    try { await fs.rename(sourceSidecar, `${destinationPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`); } catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
    const stats = await fs.stat(destinationPath);
    return this.toAsset(destination.relativePath, stats, await this.writeAssetSidecar(source.directory, destination.relativePath, { id: sidecar?.assetId || sidecar?.dummyplug?.assetId, importedAt: sidecar?.importedAt || sidecar?.dummyplug?.importedAt, mimeType: String(sidecar?.source?.mimeType || mimeFromName(destination.relativePath)), size: stats.size, lastModified: stats.mtimeMs, existing: sidecar }));
  }

  async renameAsset(projectId: string, relativePath: string, newName: string) {
    const name = this.rejectUnsafeRelative(newName);
    if (name.includes("/")) throw new ProjectLibraryError("An asset name cannot contain folders.");
    const source = await this.existingAssetPath(projectId, relativePath);
    const parent = path.posix.dirname(source.safeRelativePath);
    const candidate = parent === "." ? name : `${parent}/${name}`;
    const destination = await this.destinationWithoutConflict(source.directory, candidate);
    const destinationPath = this.assetsPath(source.directory, destination.relativePath);
    await fs.rename(source.assetPath, destinationPath);
    const oldSidecar = `${source.assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`;
    const sidecar = await this.readAssetSidecar(oldSidecar);
    try { await fs.rename(oldSidecar, `${destinationPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`); } catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
    const stats = await fs.stat(destinationPath);
    return this.toAsset(destination.relativePath, stats, await this.writeAssetSidecar(source.directory, destination.relativePath, { id: sidecar?.assetId || sidecar?.dummyplug?.assetId, importedAt: sidecar?.importedAt || sidecar?.dummyplug?.importedAt, mimeType: String(sidecar?.source?.mimeType || mimeFromName(destination.relativePath)), size: stats.size, lastModified: stats.mtimeMs, existing: sidecar }));
  }

  async trashAsset(projectId: string, relativePath: string) {
    const source = await this.existingAssetPath(projectId, relativePath);
    const trashBase = path.join(source.directory, TRASH_DIRECTORY, `${Date.now()}-${randomUUID().slice(0, 8)}`, ASSETS_DIRECTORY);
    const destination = path.join(trashBase, ...source.safeRelativePath.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source.assetPath, destination);
    try { await fs.rename(`${source.assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`, `${destination}${PROJECT_ASSET_SIDECAR_SUFFIX}`); } catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
  }

  async removeEmptyFolder(projectId: string, relativePath: string) {
    const directory = await this.projectDirectory(projectId);
    const target = this.assetsPath(directory, relativePath);
    await this.assertNoSymlinkPath(target);
    const entries = await fs.readdir(target);
    if (entries.length) throw new ProjectLibraryError("Only empty folders can be removed.", 409);
    await fs.rmdir(target);
  }

  async readAsset(projectId: string, relativePath: string) {
    const { assetPath } = await this.existingAssetPath(projectId, relativePath);
    const [bytes, stats] = await Promise.all([fs.readFile(assetPath), fs.stat(assetPath)]);
    const sidecar = await this.readAssetSidecar(`${assetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`);
    return { bytes, size: stats.size, mimeType: String(sidecar?.source?.mimeType || mimeFromName(relativePath)), lastModified: stats.mtimeMs, sha256: contentHash(bytes) };
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}
