// REST client for the /v1 sync protocol.
// Compatible with both Obsidian's requestUrl() and standard fetch() in headless test environments.

import { encodePath } from "./paths.ts";

export interface ChangeEntry {
  seq: number;
  path: string;
  rev: number;
  hash?: string;
  size: number;
  mtime: number;
  deleted: boolean;
  folder: boolean;
  updated_by?: string;
  renamed_from?: string;
}

export interface ChangesPage {
  entries: ChangeEntry[];
  next_seq: number;
  has_more: boolean;
}

export interface WriteResult {
  path: string;
  rev: number;
  seq: number;
  hash: string;
  deleted: boolean;
}

export class ConflictError extends Error {
  readonly path: string;
  readonly serverRev: number;
  readonly serverHash: string;
  readonly deleted: boolean;
  readonly serverDevice: string;

  constructor(
    path: string,
    serverRev: number,
    serverHash: string,
    deleted: boolean,
    serverDevice: string
  ) {
    super(`Conflict on ${path}: server revision is ${serverRev}`);
    this.name = "ConflictError";
    this.path = path;
    this.serverRev = serverRev;
    this.serverHash = serverHash;
    this.deleted = deleted;
    this.serverDevice = serverDevice;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;

  constructor(status: number, kind: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

// Minimal interface covering both Obsidian RequestUrlResponse and standard Response
interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export type RequestUrlFn = (params: {
  url: string;
  method?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}) => Promise<{
  status: number;
  headers: Record<string, string>;
  json: any;
  arrayBuffer: ArrayBuffer;
}>;

export class SyncClient {
  private baseUrl: string;
  private token: string;
  private deviceName: string;
  private requestUrlFn?: RequestUrlFn;

  constructor(
    baseUrl: string,
    token: string,
    deviceName = "",
    requestUrlFn?: RequestUrlFn
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.deviceName = deviceName;
    this.requestUrlFn = requestUrlFn;
  }

  private url(endpoint: string): string {
    const cleanBase = this.baseUrl.trim().replace(/\s+/g, "").replace(/\/+$/, "");
    return `${cleanBase}/v1${endpoint}`;
  }

  private async request(
    method: string,
    endpoint: string,
    opts: { body?: ArrayBuffer | string; headers?: Record<string, string> } = {}
  ): Promise<HttpResponse> {
    const fullUrl = this.url(endpoint);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      ...(this.deviceName ? { "X-Device": this.deviceName } : {}),
      ...(opts.headers ?? {}),
    };

    // Use requestUrl if provided or available in Obsidian CommonJS environment
    let reqFn = this.requestUrlFn;
    if (!reqFn && typeof require !== "undefined") {
      try {
        reqFn = require("obsidian").requestUrl;
      } catch {}
    }

    if (reqFn) {
      const resp = await reqFn({
        url: fullUrl,
        method,
        body: opts.body,
        headers,
        throw: false,
      });

      const httpResp: HttpResponse = {
        status: resp.status,
        headers: Object.fromEntries(
          Object.entries(resp.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
        ),
        json: async () => resp.json,
        arrayBuffer: async () => resp.arrayBuffer,
      };

      return this.handleResponse(httpResp);
    }

    // Fallback to standard fetch (Node.js / tests)
    const fetchResp = await fetch(fullUrl, {
      method,
      body: opts.body,
      headers,
    });

    const headerMap: Record<string, string> = {};
    fetchResp.headers.forEach((val, key) => {
      headerMap[key.toLowerCase()] = val;
    });

    const httpResp: HttpResponse = {
      status: fetchResp.status,
      headers: headerMap,
      json: () => fetchResp.json(),
      arrayBuffer: () => fetchResp.arrayBuffer(),
    };

    return this.handleResponse(httpResp);
  }

  private async handleResponse(resp: HttpResponse): Promise<HttpResponse> {
    if (resp.status === 409) {
      let j: any = {};
      try {
        j = await resp.json();
      } catch {}
      throw new ConflictError(
        String(j.path ?? ""),
        Number(j.server_rev ?? 0),
        String(j.server_hash ?? ""),
        Boolean(j.deleted),
        String(j.updated_by ?? "")
      );
    }

    if (resp.status >= 400) {
      let j: any = {};
      try {
        j = await resp.json();
      } catch {}
      throw new ApiError(
        resp.status,
        String(j.error ?? "http_error"),
        String(j.message ?? `HTTP ${resp.status}`)
      );
    }

    return resp;
  }

  async health(): Promise<{ ok: boolean }> {
    const resp = await this.request("GET", "/health");
    return (await resp.json()) as { ok: boolean };
  }

  async stats(): Promise<Record<string, number | string>> {
    const resp = await this.request("GET", "/stats");
    return (await resp.json()) as Record<string, number | string>;
  }

  async changes(since: number, limit = 500): Promise<ChangesPage> {
    const resp = await this.request("GET", `/changes?since=${since}&limit=${limit}`);
    return (await resp.json()) as ChangesPage;
  }

  async getFile(
    path: string,
    rev?: number
  ): Promise<{ data: ArrayBuffer; rev: number; hash: string }> {
    const q = rev === undefined ? "" : `&rev=${rev}`;
    const resp = await this.request("GET", `/file?path=${encodePath(path)}${q}`);
    const data = await resp.arrayBuffer();
    const revHeader = resp.headers["x-rev"];
    const etagHeader = resp.headers["etag"] || "";
    return {
      data,
      rev: Number(revHeader ?? rev ?? 0),
      hash: etagHeader.replace(/"/g, ""),
    };
  }

  async putFile(
    path: string,
    baseRev: number,
    data: ArrayBuffer,
    mtime: number
  ): Promise<WriteResult> {
    const resp = await this.request("PUT", `/file?path=${encodePath(path)}`, {
      body: data,
      headers: {
        "X-Base-Rev": String(baseRev),
        "X-Mtime": String(mtime),
        "Content-Type": "application/octet-stream",
      },
    });
    return (await resp.json()) as WriteResult;
  }

  async putFolder(path: string, baseRev: number): Promise<WriteResult> {
    const resp = await this.request("PUT", `/file?path=${encodePath(path)}`, {
      body: new ArrayBuffer(0),
      headers: {
        "X-Base-Rev": String(baseRev),
        "X-Folder": "1",
      },
    });
    return (await resp.json()) as WriteResult;
  }

  async deleteFile(path: string, baseRev: number): Promise<WriteResult> {
    const resp = await this.request("DELETE", `/file?path=${encodePath(path)}`, {
      headers: { "X-Base-Rev": String(baseRev) },
    });
    return (await resp.json()) as WriteResult;
  }

  async rename(from: string, to: string, baseRev: number): Promise<WriteResult> {
    const resp = await this.request("POST", "/rename", {
      body: JSON.stringify({
        from,
        to,
        base_rev: baseRev,
      }),
      headers: { "Content-Type": "application/json" },
    });
    return (await resp.json()) as WriteResult;
  }

  async issueToken(name: string): Promise<{ token: string; vault: string }> {
    const resp = await this.request("POST", "/tokens", {
      body: JSON.stringify({ name }),
      headers: { "Content-Type": "application/json" },
    });
    return (await resp.json()) as { token: string; vault: string };
  }
}
