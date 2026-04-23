import { compressSync, decompressSync } from "fflate";
import { DataPayloadType, StatusType, type ChunkAck, type ChunkPayload, type DataPayload, type FileMetadata, type PauseStatus, type Status } from "../types";

export const CHUNK_SIZE = 128 * 1024;

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

export function encodeDataPayload(dataPayload: DataPayload): Uint8Array {
  switch (dataPayload.type) {
    case DataPayloadType.Status: {
      const {type, data: payload} = dataPayload;
      const encodedPayload = encodeStatusMessage(payload);
      const packet = new Uint8Array(1 + encodedPayload.length);
      packet[0] = type;
      packet.set(encodedPayload, 1);
      return packet;
    }
    case DataPayloadType.SenderSigningKey: {
      const {type, data: payload} = dataPayload;
      const packet = new Uint8Array(1 + payload.length);
      packet[0] = type;
      packet.set(payload, 1);
      return packet;
    }
    case DataPayloadType.RecipientEncryptionKey: {
      const {type, data: payload} = dataPayload;
      const packet = new Uint8Array(1 + payload.length);
      packet[0] = type;
      packet.set(payload, 1);
      return packet;
    }
    case DataPayloadType.FileInfo: {
      const {type, data: payload} = dataPayload;
      const encodedPayload = encodeFileMetadataList(payload);
      const packet = new Uint8Array(1 + encodedPayload.length);
      packet[0] = type;
      packet.set(encodedPayload, 1);
      return packet;
    }
    case DataPayloadType.Chunk: {
      const {type, data: payload} = dataPayload;
      const encodedPayload = encodeChunkPayload(payload);
      const packet = new Uint8Array(1 + encodedPayload.length);
      packet[0] = type;
      packet.set(encodedPayload, 1);
      return packet;
    }
    case DataPayloadType.ChunkAck: {
      const {type, data: payload} = dataPayload;
      const encodedePayload = encodeChunkAck(payload);
      const packet = new Uint8Array(1 + encodedePayload.length);
      packet[0] = type;
      packet.set(encodedePayload, 1);
      return packet;
    }
    case DataPayloadType.PauseInfo: {
      const {type, data: payload} = dataPayload;
      const encodedePayload = encodePauseStatus(payload);
      const packet = new Uint8Array(1 + encodedePayload.length);
      packet[0] = type;
      packet.set(encodedePayload, 1);
      return packet;
    }
  }
}

export function encodeStatusMessage(status: Status) {
  const {type, ok} = status
  const packet = new Uint8Array(2);
  packet[0] = type;
  packet[1] = ok ? 255 : 0;
  return packet
}

export function decodeStatusMessage(packet: Uint8Array): Status {
  const type = packet[0] as StatusType;
  
  // Convert 255 back to true, 0 to false
  const ok = packet[1] === 255; 
  
  return { type, ok };
}

export function encodeFileMetadataList(fileMetadataList: FileMetadata[]): Uint8Array {
  const stringEncoder = new TextEncoder();
  const encodedFiles: Uint8Array[] = [];
  let totalSize = 0;

  for (const metadata of fileMetadataList) {
    const { fileId, rootHash, signature, totalChunks, ephemeralPublicKey } = metadata;
    const { fileSize, fileType, fileName } = metadata.fileInfo;

    const encodedFileType = stringEncoder.encode(fileType);
    const encodedFileName = stringEncoder.encode(fileName);

    // ID(1) + Hash(32) + Sig(64) + ephemeralKey(91) + TotalChunks(4) + FileSize(8) + TypeLen(1) + NameLen(1) + Strings
    const entrySize = 1 + rootHash.length + signature.length + ephemeralPublicKey.length + 4 + 8 + 1 + 1 + encodedFileType.length + encodedFileName.length;
    
    const filePacket = new Uint8Array(entrySize);
    let offset = 0;

    // 1. File ID
    filePacket[offset] = fileId;
    offset += 1;

    // 2. File Hash
    filePacket.set(rootHash, offset);
    console.log(rootHash.length);
    offset += rootHash.length;

    filePacket.set(ephemeralPublicKey, offset);
    offset += ephemeralPublicKey.length;

    // 3. Signature
    filePacket.set(signature, offset);
    offset += signature.length;

    // EphemeralPublicKey
    


    // 4. Total Chunks (4 bytes)
    setUint32BE(filePacket, offset, totalChunks);
    offset += 4;

    // 5. File Size (8 bytes)
    setBigUint64BE(filePacket, offset, BigInt(fileSize));
    offset += 8;

    // 6. File Type Length + Data
    filePacket[offset] = encodedFileType.length;
    offset += 1;
    filePacket.set(encodedFileType, offset);
    offset += encodedFileType.length;

    // 7. File Name Length + Data
    filePacket[offset] = encodedFileName.length;
    offset += 1;
    filePacket.set(encodedFileName, offset);
    offset += encodedFileName.length;

    encodedFiles.push(filePacket);
    totalSize += entrySize;
  }

  const finalBuffer = new Uint8Array(totalSize);
  let mainOffset = 0;
  for (const fileBuffer of encodedFiles) {
    finalBuffer.set(fileBuffer, mainOffset);
    mainOffset += fileBuffer.length;
  }

  return finalBuffer;
}

export function decodeFileMetadataList(buffer: Uint8Array): FileMetadata[] {
  const list: FileMetadata[] = [];
  const stringDecoder = new TextDecoder();
  let offset = 0;

  const HASH_LENGTH = 32; 
  const SIG_LENGTH = 64;
  const KEY_LEN = 91;

  while (offset < buffer.length) {
    // 1. File ID
    const fileId = buffer[offset];
    offset += 1;

    // 2. File Hash (using subarray to avoid copying memory)
    const rootHash = buffer.subarray(offset, offset + HASH_LENGTH);
    offset += HASH_LENGTH;

    const ephemeralPublicKey = buffer.subarray(offset, offset + KEY_LEN);
    offset += KEY_LEN;

    // 3. Signature
    const signature = buffer.subarray(offset, offset + SIG_LENGTH);
    offset += SIG_LENGTH;

    // EphemeralPublicKey
    

    // 4. Total Chunks (4 bytes)
    const totalChunks = getUint32BE(buffer, offset);
    offset += 4;

    // 5. File Size (8 bytes)
    const fileSize = Number(getBigUint64BE(buffer, offset));
    offset += 8;

    // 6. File Type
    const typeLen = buffer[offset];
    offset += 1;
    const fileType = stringDecoder.decode(buffer.subarray(offset, offset + typeLen));
    offset += typeLen;

    // 7. File Name
    const nameLen = buffer[offset];
    offset += 1;
    const fileName = stringDecoder.decode(buffer.subarray(offset, offset + nameLen));
    offset += nameLen;

    list.push({
      fileId,
      rootHash,
      signature,
      ephemeralPublicKey,
      totalChunks,
      fileInfo: {
        fileSize,
        fileType,
        fileName
      }
    });
  }

  return list;
}

export function encodeChunkPayload(chunkPayload: ChunkPayload): Uint8Array {
  const {chunkId, fileId, ciphertext, iv} = chunkPayload;
  const packetSize = 4 + 1 + ciphertext.length + iv.length;
  const encodedPayload = new Uint8Array(packetSize);

  let offset = 0;

  setUint32BE(encodedPayload, offset, chunkId);
  offset += 4;

  encodedPayload[offset] = fileId;
  offset += 1;

  encodedPayload.set(iv, offset);
  offset += iv.length;

  encodedPayload.set(ciphertext, offset);

  return encodedPayload;
}

export function decodeChunkPayload(buffer: Uint8Array): ChunkPayload {
  const IV_LEN = 12;
  
  let offset = 0;

  const chunkId = getUint32BE(buffer, offset);
  offset += 4;

  const fileId = buffer[offset];
  offset += 1;

  const iv = buffer.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;

  const ciphertext = buffer.subarray(offset);

  return { chunkId, fileId, iv, ciphertext };
}

export function encodeChunkAck(chunkAck: ChunkAck): Uint8Array {
  const {fileId, chunkId} = chunkAck;
  const chunkAckPacket = new Uint8Array(1 + 4);
  let offset = 0;

  chunkAckPacket[offset] = fileId;
  offset += 1;

  setUint32BE(chunkAckPacket, offset, chunkId);

  return chunkAckPacket;
}

export function decodeChunkAck(buffer: Uint8Array): ChunkAck {
  let offset = 0;
  
  const fileId = buffer[offset];
  offset += 1;

  const chunkId = getUint32BE(buffer, offset);

  return {fileId, chunkId};
}

export function encodePauseStatus(pauseStatus: PauseStatus): Uint8Array {
  const {pause, from, resumeFromFileId, resumeFromChunkId} = pauseStatus;
  const pauseStatusPacket = new Uint8Array(1 + 1 + 1 + 4);

  let offset = 0;

  pauseStatusPacket[offset] = pause ? 255 : 0;
  offset += 1;

  pauseStatusPacket[offset] = from === "sender" ? 0 : 255;
  offset += 1;

  pauseStatusPacket[offset] = resumeFromFileId;
  offset += 1;

  setUint32BE(pauseStatusPacket ,offset, resumeFromChunkId);

  return pauseStatusPacket;
}

export function decodePauseStatus(buffer: Uint8Array): PauseStatus {
  let offset = 0;

  const pause = buffer[offset] === 255;
  offset += 1;

  const from = buffer[offset] === 0 ? "sender" : "reciever";
  offset += 1;

  const resumeFromFileId = buffer[offset];
  offset += 1;

  const resumeFromChunkId = getUint32BE(buffer, offset);

  return {pause, from, resumeFromFileId, resumeFromChunkId};
}

function setUint32BE(array: Uint8Array, offset: number, value: number): void {
  array[offset]     = (value >>> 24) & 0xFF;
  array[offset + 1] = (value >>> 16) & 0xFF;
  array[offset + 2] = (value >>> 8)  & 0xFF;
  array[offset + 3] =  value         & 0xFF;
}

function getUint32BE(array: Uint8Array, offset: number): number {
  // Use >>> 0 at the end to ensure the result is treated as an unsigned 32-bit integer
  return (
    (array[offset]     << 24) |
    (array[offset + 1] << 16) |
    (array[offset + 2] << 8)  |
     array[offset + 3]
  ) >>> 0;
}


function setBigUint64BE(array: Uint8Array, offset: number, value: bigint): void {
  for (let i = 7; i >= 0; i--) {
    array[offset + i] = Number(value & 0xFFn);
    value >>= 8n;
  }
}

function getBigUint64BE(array: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value = (value << 8n) | BigInt(array[offset + i]);
  }
  return value;
}

export async function generateMerkleBase(accessHandle: FileSystemSyncAccessHandle, totalChunks: number) {
    const chunkSize = CHUNK_SIZE;
    const leafHashes = new Uint8Array(totalChunks * 32);
    const buffer = new Uint8Array(chunkSize);

    for (let i = 0; i < totalChunks; i++) {
        const bytesRead = accessHandle.read(buffer, { at: i * chunkSize });
        const dataToHash = bytesRead < chunkSize ? buffer.slice(0, bytesRead) : buffer;
        
        const hash = await crypto.subtle.digest('SHA-256', dataToHash);
        leafHashes.set(new Uint8Array(hash), i * 32);
    }

    // Helper to build the root from the flat leaf array
    const rootHash = await buildRoot(leafHashes);
    return { rootHash, leafHashes };
}

// Internal helper to calculate the root from leaves
export async function buildRoot(leafHashes: Uint8Array) {
    let currentLevel = [];
    for (let i = 0; i < leafHashes.length; i += 32) {
        currentLevel.push(leafHashes.slice(i, i + 32));
    }

    while (currentLevel.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            if (i + 1 < currentLevel.length) {
                const combined = new Uint8Array(64);
                combined.set(currentLevel[i]);
                combined.set(currentLevel[i + 1], 32);
                const parent = await crypto.subtle.digest('SHA-256', combined);
                nextLevel.push(new Uint8Array(parent));
            } else {
                nextLevel.push(currentLevel[i]);
            }
        }
        currentLevel = nextLevel;
    }
    return currentLevel[0];
}

async function getMerkleProof(leafHashes: Uint8Array, index: number) {
    let nodes = [];
    for (let i = 0; i < leafHashes.length; i += 32) {
        nodes.push(leafHashes.slice(i, i + 32));
    }

    const proof = [];
    let currentIndex = index;

    while (nodes.length > 1) {
        const nextLevel = [];
        const isRightNode = currentIndex % 2 === 1;
        const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

        // If sibling exists, add to proof; if not (odd end of tree), nothing to add for this level
        if (siblingIndex < nodes.length) {
            proof.push(nodes[siblingIndex]);
        }

        // Build the next level to continue climbing
        for (let i = 0; i < nodes.length; i += 2) {
            if (i + 1 < nodes.length) {
                const combined = new Uint8Array(64);
                combined.set(nodes[i]);
                combined.set(nodes[i + 1], 32);
                const parent = await crypto.subtle.digest('SHA-256', combined);
                nextLevel.push(new Uint8Array(parent));
            } else {
                nextLevel.push(nodes[i]);
            }
        }
        nodes = nextLevel;
        currentIndex = Math.floor(currentIndex / 2);
    }

    const flatProof = new Uint8Array(proof.length * 32);
    for (let i = 0; i < proof.length; i++) {
        flatProof.set(proof[i], i * 32);
    }

    return flatProof;
}

async function verifyChunk(rootHash: Uint8Array, chunkHash: Uint8Array, flatProof: Uint8Array, index: number) {
    let currentHash = chunkHash;
    const numLevels = flatProof.length / 32;

    for (let i = 0; i < numLevels; i++) {
        // Extract the sibling directly from the flat array without slicing
        const sibling = flatProof.subarray(i * 32, (i + 1) * 32);
        
        const combined = new Uint8Array(64);
        if ((index >> i) & 1) {
            combined.set(sibling, 0);
            combined.set(currentHash, 32);
        } else {
            combined.set(currentHash, 0);
            combined.set(sibling, 32);
        }

        const parent = await crypto.subtle.digest('SHA-256', combined);
        currentHash = new Uint8Array(parent);
    }

    return currentHash.every((value, i) => value === rootHash[i]);
}