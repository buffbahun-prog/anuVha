import { compressSync, decompressSync } from "fflate";

// ------------------- KEY MANAGEMENT -------------------
export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
}

export async function generateEncryptionKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
}

// ------------------- SEND FUNCTION -------------------
export async function compressEncryptSign(
  senderSigningKey: CryptoKeyPair,
  recipientEncryptionKey: CryptoKey,
  data: ArrayBuffer | Uint8Array | Blob
) {
  // Convert data to ArrayBuffer
  let plainBuffer: ArrayBuffer;
  if (data instanceof Blob) {
    plainBuffer = await data.arrayBuffer();
  } else if (data instanceof Uint8Array) {
    plainBuffer = data.slice().buffer;
  } else {
    plainBuffer = data;
  }

  // ---------------- COMPRESSION ----------------
  // const compressedUint8 = compressSync(new Uint8Array(plainBuffer));
  // const compressed = new Uint8Array(compressedUint8).slice().buffer;

  // ---------------- EPHEMERAL ECDH ----------------
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );

  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: recipientEncryptionKey },
    ephemeralKeyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));

  // ---------------- ENCRYPT ----------------
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plainBuffer);

  // ---------------- SIGN ----------------
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    senderSigningKey.privateKey,
    ciphertext
  );

  // Export ephemeral key for recipient
  const ephemeralPublicKey = await crypto.subtle.exportKey("spki", ephemeralKeyPair.publicKey);

  return { ciphertext, iv, signature, ephemeralPublicKey };
}

// ------------------- RECEIVE FUNCTION -------------------
export async function decryptVerifyDecompress(
  senderSigningKey: CryptoKey,
  recipientEncryptionKey: CryptoKeyPair,
  payload: {
    ciphertext: ArrayBuffer;
    iv: Uint8Array;
    signature: ArrayBuffer;
    ephemeralPublicKey: ArrayBuffer;
  }
): Promise<Uint8Array> {
  const { ciphertext, iv, signature, ephemeralPublicKey } = payload;

  // ---------------- VERIFY SIGNATURE ----------------
  const isValid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    senderSigningKey,
    signature,
    ciphertext
  );

  if (!isValid) throw new Error("Signature verification failed");

  // ---------------- IMPORT EPHEMERAL KEY ----------------
  const importedEphemeralKey = await crypto.subtle.importKey(
    "spki",
    ephemeralPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  // ---------------- DERIVE AES KEY ----------------
  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: importedEphemeralKey },
    recipientEncryptionKey.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // ---------------- DECRYPT ----------------
  const decryptedCompressed = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    aesKey,
    ciphertext
  );

  // ---------------- DECOMPRESS ----------------
  return new Uint8Array(decryptedCompressed);
  // return decompressSync(new Uint8Array(decryptedCompressed));
}

// ------------------- UTILS -------------------
export function arrayBufferToBlob(buffer: ArrayBuffer, type = "application/octet-stream") {
  return new Blob([buffer], { type });
}

export function uint8ArrayToBlob(array: Uint8Array, type = "application/octet-stream") {
  return new Blob([array.slice().buffer], { type });
}

export async function blobToUint8Array(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}