import type { IncomingMessage, ServerResponse } from "node:http";
import { ProjectLibrary, ProjectLibraryError } from "./project-library-server.ts";

function json(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

async function bodyBytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function bodyJson(request: IncomingMessage) {
  const body = (await bodyBytes(request)).toString("utf8");
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function required(url: URL, name: string) {
  const value = url.searchParams.get(name);
  if (!value) throw new ProjectLibraryError(`${name} is required.`);
  return value;
}

function modifiedHeader(request: IncomingMessage) {
  const value = Number(request.headers["x-dummyplug-last-modified"] || 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Local-only Vite middleware. It is intentionally absent from the deployable worker. */
export function createProjectLibraryMiddleware(library = new ProjectLibrary()) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || "/", "http://dummyplug.local");
    const route = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (route === "/projects" && request.method === "GET") return json(response, 200, { projects: await library.listProjects(), root: library.root });
      if (route === "/projects" && request.method === "POST") {
        const body = await bodyJson(request);
        return json(response, 201, { project: await library.createProject(String(body.name || "")), root: library.root });
      }
      if (route === "/project" && request.method === "GET") return json(response, 200, { project: await library.getProject(required(url, "projectId")), root: library.root });
      if (route === "/project" && request.method === "PATCH") {
        const body = await bodyJson(request);
        return json(response, 200, { project: await library.updateProject(required(url, "projectId"), body) });
      }
      if (route === "/draft" && request.method === "GET") return json(response, 200, { draft: await library.getDraft(required(url, "projectId")) });
      if (route === "/draft" && request.method === "PUT") return json(response, 200, { draft: await library.updateDraft(required(url, "projectId"), await bodyJson(request)) });
      if ((route === "/assets" || route === "/refresh") && (request.method === "GET" || request.method === "POST")) {
        const projectId = required(url, "projectId");
        const [assets, folders] = await Promise.all([library.recrawl(projectId), library.listFolders(projectId)]);
        return json(response, 200, { assets, folders });
      }
      if (route === "/import" && request.method === "POST") {
        const imported = await library.importAsset(required(url, "projectId"), {
          relativePath: required(url, "path"),
          bytes: await bodyBytes(request),
          mimeType: String(request.headers["content-type"] || "application/octet-stream"),
          lastModified: modifiedHeader(request),
          sidecar: request.headers["x-dummyplug-sidecar"] ? Buffer.from(String(request.headers["x-dummyplug-sidecar"]), "base64").toString("utf8") : undefined,
        });
        return json(response, 201, { asset: imported });
      }
      if (route === "/asset" && request.method === "GET") {
        const asset = await library.readAsset(required(url, "projectId"), required(url, "path"));
        const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
        let start = 0; let end = asset.bytes.byteLength - 1;
        if (range) {
          start = range[1] ? Number(range[1]) : 0;
          end = range[2] ? Number(range[2]) : end;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= asset.bytes.byteLength) {
            response.statusCode = 416;
            response.setHeader("content-range", `bytes */${asset.bytes.byteLength}`);
            return response.end();
          }
          end = Math.min(end, asset.bytes.byteLength - 1);
          response.statusCode = 206;
          response.setHeader("content-range", `bytes ${start}-${end}/${asset.bytes.byteLength}`);
        } else response.statusCode = 200;
        response.setHeader("accept-ranges", "bytes");
        response.setHeader("content-length", end - start + 1);
        response.setHeader("content-type", asset.mimeType);
        response.setHeader("cache-control", "private, max-age=0, must-revalidate");
        return response.end(asset.bytes.subarray(start, end + 1));
      }
      if (route === "/metadata" && request.method === "PATCH") {
        const body = await bodyJson(request);
        const asset = await library.updateAssetMetadata(required(url, "projectId"), required(url, "path"), body);
        return json(response, 200, { asset });
      }
      if (route === "/folder" && request.method === "POST") {
        const body = await bodyJson(request); await library.createFolder(required(url, "projectId"), String(body.path || "")); return json(response, 201, { ok: true });
      }
      if (route === "/folder" && request.method === "DELETE") {
        await library.removeEmptyFolder(required(url, "projectId"), required(url, "path")); return json(response, 200, { ok: true });
      }
      if (route === "/folder-move" && request.method === "POST") {
        const body = await bodyJson(request); await library.moveFolder(required(url, "projectId"), String(body.path || ""), String(body.destinationFolder || "")); return json(response, 200, { ok: true });
      }
      if (route === "/folder-rename" && request.method === "POST") {
        const body = await bodyJson(request); await library.renameFolder(required(url, "projectId"), String(body.path || ""), String(body.newName || "")); return json(response, 200, { ok: true });
      }
      if (route === "/move" && request.method === "POST") {
        const body = await bodyJson(request); return json(response, 200, { asset: await library.moveAsset(required(url, "projectId"), String(body.path || ""), String(body.destinationFolder || "")) });
      }
      if (route === "/rename" && request.method === "POST") {
        const body = await bodyJson(request); return json(response, 200, { asset: await library.renameAsset(required(url, "projectId"), String(body.path || ""), String(body.newName || "")) });
      }
      if (route === "/trash" && request.method === "POST") {
        const body = await bodyJson(request); await library.trashAsset(required(url, "projectId"), String(body.path || "")); return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: "Project library route was not found." });
    } catch (error) {
      const status = error instanceof ProjectLibraryError ? error.status : error instanceof SyntaxError ? 400 : 500;
      return json(response, status, { error: error instanceof Error ? error.message : "Project library error." });
    }
  };
}
