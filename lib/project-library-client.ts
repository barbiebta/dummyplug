import type { ProjectAsset, ProjectDraft, ProjectManifest, ProjectOutputSettings } from "./project-contract";

const BASE = "/library-bridge";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* handled below */ }
  if (!response.ok) throw new Error(String(payload.error || text || `Project library returned ${response.status}.`));
  return payload as T;
}

function query(values: Record<string, string>) {
  return `?${new URLSearchParams(values).toString()}`;
}

export async function listProjects() {
  return request<{ projects: ProjectManifest[]; root: string }>("/projects");
}

export async function createProject(name: string) {
  return request<{ project: ProjectManifest; root: string }>("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
}

export async function loadProject(projectId: string) {
  const suffix = query({ projectId });
  const [project, draft, assets] = await Promise.all([
    request<{ project: ProjectManifest; root: string }>(`/project${suffix}`),
    request<{ draft: ProjectDraft }>(`/draft${suffix}`),
    request<{ assets: ProjectAsset[]; folders: string[] }>(`/assets${suffix}`),
  ]);
  return { project: project.project, root: project.root, draft: draft.draft, assets: assets.assets, folders: assets.folders || [] };
}

export async function updateProjectSettings(projectId: string, outputSettings: Partial<ProjectOutputSettings>) {
  return request<{ project: ProjectManifest }>(`/project${query({ projectId })}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outputSettings }) });
}

export async function saveProjectDraft(projectId: string, draft: Partial<Omit<ProjectDraft, "schema" | "projectId" | "updatedAt">>) {
  return request<{ draft: ProjectDraft }>(`/draft${query({ projectId })}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
}

export async function refreshProjectAssets(projectId: string) {
  return request<{ assets: ProjectAsset[]; folders: string[] }>(`/refresh${query({ projectId })}`, { method: "POST" });
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function importProjectAsset(projectId: string, file: File, relativePath = file.webkitRelativePath || file.name, sidecarText?: string) {
  return (await request<{ asset: ProjectAsset }>(`/import${query({ projectId, path: relativePath.replaceAll("\\", "/") })}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream", "x-dummyplug-last-modified": String(file.lastModified), ...(sidecarText ? { "x-dummyplug-sidecar": base64Utf8(sidecarText) } : {}) },
    body: file,
  })).asset;
}

export function projectAssetUrl(projectId: string, relativePath: string) {
  return `${BASE}/asset${query({ projectId, path: relativePath })}`;
}

export async function updateProjectAsset(projectId: string, relativePath: string, changes: { metadata?: Record<string, unknown>; analysis?: Record<string, unknown>; sourceFacts?: Record<string, unknown> }) {
  return (await request<{ asset: ProjectAsset }>(`/metadata${query({ projectId, path: relativePath })}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) })).asset;
}

export async function createProjectFolder(projectId: string, path: string) {
  return request<{ ok: true }>(`/folder${query({ projectId })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}

export async function removeProjectFolder(projectId: string, path: string) {
  return request<{ ok: true }>(`/folder${query({ projectId, path })}`, { method: "DELETE" });
}

export async function moveProjectFolder(projectId: string, path: string, destinationFolder: string) {
  return request<{ ok: true }>(`/folder-move${query({ projectId })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, destinationFolder }) });
}

export async function renameProjectFolder(projectId: string, path: string, newName: string) {
  return request<{ ok: true }>(`/folder-rename${query({ projectId })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, newName }) });
}

export async function moveProjectAsset(projectId: string, path: string, destinationFolder: string) {
  return request<{ asset: ProjectAsset }>(`/move${query({ projectId })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, destinationFolder }) });
}

export async function renameProjectAsset(projectId: string, path: string, newName: string) {
  return request<{ asset: ProjectAsset }>(`/rename${query({ projectId })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, newName }) });
}

export async function trashProjectAsset(projectId: string, path: string) {
  return request<{ ok: true }>(`/trash${query({ projectId })}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}
