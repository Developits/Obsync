// Bearer token authentication and management using SHA-256 digests in D1.

import { sha256Hex } from "./storage.ts";

export interface TokenRecord {
  id: string;
  name: string;
  hash: string;
  created_at: number;
  last_used: number;
}

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  return sha256Hex(encoder.encode(token).buffer as ArrayBuffer);
}

export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let str = "";
  for (const b of bytes) {
    str += String.fromCharCode(b);
  }
  return "obs_" + btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function validateToken(db: D1Database, authHeader: string | null): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return false;
  }

  const hash = await hashToken(token);
  const record = await db
    .prepare("SELECT id FROM tokens WHERE hash = ?")
    .bind(hash)
    .first<{ id: string }>();

  if (!record) {
    return false;
  }

  // Update last_used asynchronously without blocking request
  db.prepare("UPDATE tokens SET last_used = ? WHERE id = ?")
    .bind(Date.now(), record.id)
    .run()
    .catch(() => {});

  return true;
}

export async function countTokens(db: D1Database): Promise<number> {
  const res = await db.prepare("SELECT COUNT(*) as cnt FROM tokens").first<{ cnt: number }>();
  return res?.cnt ?? 0;
}

export async function createToken(
  db: D1Database,
  name: string
): Promise<{ token: string; id: string }> {
  const token = generateToken();
  const hash = await hashToken(token);
  const id = crypto.randomUUID();
  const now = Date.now();

  await db
    .prepare("INSERT INTO tokens (id, name, hash, created_at, last_used) VALUES (?, ?, ?, ?, ?)")
    .bind(id, name, hash, now, now)
    .run();

  return { token, id };
}
