import type { AssetRecord, JobSettings } from "./types";

const DATABASE = "dummyplug-single-shot-workspace-v2";
const STORE = "workspace";
const KEY = "current";

export interface PersistedAsset {
  record: Omit<AssetRecord, "previewUrl">;
  file?: File;
  sourceHandle?: PersistedFileHandle;
  sourceDirectory?: PersistedDirectoryHandle;
}

export interface PersistedWritableFile { write(data: string): Promise<void>; close(): Promise<void> }
export interface PersistedFileHandle {
  kind: "file";
  name?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<PersistedWritableFile>;
  queryPermission?(options?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  requestPermission?(options?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
}
export interface PersistedDirectoryHandle {
  kind: "directory";
  name?: string;
  entries(): AsyncIterableIterator<[string, PersistedFileHandle | PersistedDirectoryHandle]>;
  getFileHandle(name: string, options: { create: boolean }): Promise<PersistedFileHandle>;
  queryPermission?(options?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
  requestPermission?(options?: { mode?: "read" | "readwrite" }): Promise<"granted" | "denied" | "prompt">;
}

export interface PersistedWorkspace {
  version: 2;
  assets: PersistedAsset[];
  metadataDirectory?: PersistedDirectoryHandle;
  selectedAssetId: string;
  simplePrompt: string;
  durationSeconds: number;
  generatedPrompt: string;
  promptHistory?: string[];
  jobSettings?: JobSettings;
  requireNonDiegeticMusicNA?: boolean;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open browser workspace storage."));
  });
}

export async function loadBrowserWorkspace() {
  const database = await openDatabase();
  try {
    return await new Promise<PersistedWorkspace | null>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as PersistedWorkspace | undefined) || null);
      request.onerror = () => reject(request.error || new Error("Could not read browser workspace storage."));
    });
  } finally {
    database.close();
  }
}

export async function saveBrowserWorkspace(workspace: PersistedWorkspace) {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(workspace, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save browser workspace storage."));
      transaction.onabort = () => reject(transaction.error || new Error("Browser workspace save was aborted."));
    });
  } finally {
    database.close();
  }
}
