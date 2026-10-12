// Content-addressed blob storage (R2) and cryptographic hashing using WebCrypto.

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export function blobKey(hash: string): string {
  // Sharded blob path for fast lookup and deduplication
  return `blobs/${hash.slice(0, 2)}/${hash}`;
}

export async function putBlob(bucket: R2Bucket, hash: string, data: ArrayBuffer): Promise<void> {
  const key = blobKey(hash);
  // Check if blob already exists to avoid redundant write costs
  const existing = await bucket.head(key);
  if (existing) {
    return;
  }
  await bucket.put(key, data, {
    httpMetadata: {
      contentType: "application/octet-stream",
    },
    sha256: hash,
  });
}

export async function getBlob(
  bucket: R2Bucket,
  hash: string,
  range?: R2Range
): Promise<R2ObjectBody | null> {
  const key = blobKey(hash);
  return (await bucket.get(key, range ? { range } : undefined)) as R2ObjectBody | null;
}
