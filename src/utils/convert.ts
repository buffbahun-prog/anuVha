import { compressSync, decompressSync } from "fflate";

export type Sample = { time: number; bytes: number };

// ====== UTILITIES ======
export function bufferToBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function cryptoKeyToBase64(key: CryptoKey): Promise<string> {
  // Export key (format depends on key type)
  const exported = await crypto.subtle.exportKey(
    "spki",
    key
  );

  // Convert ArrayBuffer → Base64
  const bytes = new Uint8Array(exported);
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));

  return btoa(binary);
}

export async function importECDHPublicKey(base64: string) {
  return crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(base64),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}

export async function importECDSAPublicKey(base64: string) {
  return crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(base64),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export function formatFileSize(bytes: number, decimals: number = 2): string {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;

    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    const value = bytes / Math.pow(k, i);

    return `${parseFloat(value.toFixed(dm))} ${sizes[i]}`;
}

export function getUploadSpeed(samples: Sample[]): string {
    const now = performance.now();
    const windowMs = 1000; // 1 second

    // keep only recent samples
    samples = samples.filter(s => now - s.time <= windowMs);

    const totalBytes = samples.reduce((sum, s) => sum + s.bytes, 0);

    const bytesPerSec = totalBytes / (windowMs / 1000); // bytes/sec
    return `${formatFileSize(bytesPerSec)}/s`
}

export function getFileCategory(file?: File, type?: string) {
  if (!type) return;
  type = file ? file.type : type;
  if (type.startsWith("image/")) return "Image";
  if (type.startsWith("video/")) return "Video";
  if (type.startsWith("audio/")) return "Audio";
  if (type === "application/pdf") return "PDF";
  if (type.includes("zip") || type.includes("rar")) return "Archive";
  if (type.includes("text")) return "Text";
  return "File";
}

export const compressJSON = (data: any): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return btoa(String.fromCharCode(...compressSync(bytes)));
};

export const decompressJSON = (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(decompressSync(bytes)));
};

export const encodeSDP = (sdp: string, type: RTCSdpType) => {
  // 1. Convert string → bytes
  const sdpBytes = new TextEncoder().encode(sdp);

  // 2. Compress
  const compressed = compressSync(sdpBytes);

  // 3. Add 1-byte header (0 = offer, 1 = answer)
  const payload = new Uint8Array(1 + compressed.length);
  payload[0] = type === "offer" ? 0 : 1;
  payload.set(compressed, 1);

  return payload;
}

export const decodeSDP = (payload: Uint8Array<ArrayBuffer>) => {
  // 1. Extract type
  const type = payload[0] === 0 ? "offer" : "answer";

  // 2. Extract compressed data
  const compressed = payload.slice(1);

  // 3. Decompress
  const sdpBytes = decompressSync(compressed);

  // 4. Convert back to string
  const sdp = new TextDecoder().decode(sdpBytes);

  return { type, sdp };
}