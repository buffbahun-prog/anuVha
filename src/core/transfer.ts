import { compressSync, decompressSync } from "fflate";

export const CHUNK_SIZE = 16 * 1024;

export function splitIntoChunks(buffer: ArrayBuffer) {
  const chunks: ArrayBuffer[] = [];
  for (let i = 0; i < buffer.byteLength; i += CHUNK_SIZE) {
    chunks.push(buffer.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

export function compressData(data: any): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return btoa(String.fromCharCode(...compressSync(bytes)));
}

export function decompressData(base64: string) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(decompressSync(bytes)));
}