// import { compressSync, decompressSync } from "fflate";

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
// export async function compressEncryptSign(
//   recipientEncryptionKey: CryptoKey,
//   data: ArrayBuffer | Uint8Array
// ) {

//   // ---------------- EPHEMERAL ECDH ----------------
//   const ephemeralKeyPair = await crypto.subtle.generateKey(
//     { name: "ECDH", namedCurve: "P-256" },
//     true,
//     ["deriveKey"]
//   );

//   const aesKey = await crypto.subtle.deriveKey(
//     { name: "ECDH", public: recipientEncryptionKey },
//     ephemeralKeyPair.privateKey,
//     { name: "AES-GCM", length: 256 },
//     false,
//     ["encrypt"]
//   );

//   const iv = crypto.getRandomValues(new Uint8Array(12));

//   // ---------------- ENCRYPT ----------------
//   const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new Uint8Array(data));

//   // Export ephemeral key for recipient
//   const ephemeralPublicKey = await crypto.subtle.exportKey("spki", ephemeralKeyPair.publicKey);

//   return { ciphertext, iv, ephemeralPublicKey };
// }

export async function encryptJustChunk(aesKey: CryptoKey, data: Uint8Array | ArrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, 
    aesKey, 
    new Uint8Array(data)
  );
  return { ciphertext, iv };
}

// ------------------- RECEIVE FUNCTION -------------------
export async function decryptVerifyDecompress(
  recipientEncryptionKey: CryptoKeyPair,
  payload: {
    ciphertext: ArrayBuffer;
    iv: Uint8Array;
    ephemeralPublicKey: ArrayBuffer;
  }
): Promise<Uint8Array> {
  const { ciphertext, iv, ephemeralPublicKey } = payload;

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
  try {
    const decryptedCompressed = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    aesKey,
    ciphertext
    );

    return new Uint8Array(decryptedCompressed);
  } catch(e) {
    console.error("here");
    return new Uint8Array();
  }

  // ---------------- DECOMPRESS ----------------
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