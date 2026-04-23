import { encryptJustChunk } from "../../crypto/encryption";

let subKey: CryptoKey | null = null;

self.onmessage = async (e) => {
  const { chunk, rawKey, chunkId, fileId } = e.data;

  if (!subKey) {
    subKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
  }

  // crypto.subtle.encrypt creates a NEW ArrayBuffer
  const encrypted = await encryptJustChunk(subKey, chunk);

  // Transfer the NEW buffer back to the main thread
  // This is safe because no one else has a reference to this ciphertext yet
  self.postMessage({
    chunkId,
    fileId,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv
  }, [encrypted.ciphertext]); 
};