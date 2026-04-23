import { encryptJustChunk } from "../../crypto/encryption";
import { calculateFileHash } from "../../crypto/hasher";
import { DataPayloadType, WorkerAction, type ChunkPayload, type SenderFileRecord, type WorkerRequest, type WorkerResponse } from "../../types";
import { getMissingChunks } from "../../utils/convert";
import { CHUNK_SIZE, encodeDataPayload} from "../transfer";

let resolveReady: (() => void) | null = null;
const waitForBackpressureReady = () => new Promise<void>((resolve) => {
    resolveReady = resolve;
});

let resolveResume: (() => void) | null = null;
let pausePromise: Promise<void> | null = null;
let isPaused = false;

const checkPause = () => {
    if (!isPaused) return Promise.resolve();
    if (!pausePromise) {
        pausePromise = new Promise<void>((resolve) => {
            resolveResume = resolve;
        });
    }
    return pausePromise;
};

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { action, payload } = e.data;
  
  switch (action) {
    case WorkerAction.GetMetadata: {
        try {
            const {fileHandleList, signingKeyPair} = payload;
            const metadataList = await initFileRecordList(fileHandleList, signingKeyPair);
            const response: WorkerResponse = {
                action: action,
                status: "SUCCESS",
                result: metadataList,
            }
            self.postMessage(response);
        } catch(e: any) {
            const response: WorkerResponse = {
                action: action,
                status: "ERROR",
                error: e.message,
            }
            self.postMessage(response);
        } finally {
            break;
        }
    }
    case WorkerAction.GetEncryptedChunk: {
        try {
            const {recipientKey, filesRecordList} = payload;
            transferChunks(recipientKey, filesRecordList, async (chunk) => {
                await checkPause();

                const packet = new Uint8Array(encodeDataPayload({
                    type: DataPayloadType.Chunk,
                    data: chunk,
                })).buffer;
                const response: WorkerResponse = {
                    action: action,
                    status: "SUCCESS",
                    result: {packet, chunkId: chunk.chunkId, fileId: chunk.fileId},
                };
                self.postMessage(response, [packet, chunk.ciphertext.buffer]);

                await waitForBackpressureReady();
            });
        } catch(e: any) {
            const response: WorkerResponse = {
                action: action,
                status: "ERROR",
                error: e.message,
            }
            self.postMessage(response);
        } finally {
            break;
        }
    }
    case WorkerAction.NextChunkReady: {
        if (resolveReady) resolveReady();
        break;
    }
    case WorkerAction.Pause: {
        isPaused = true;
        break;
    }
    case WorkerAction.Resume: {
        isPaused = false;
        if (resolveResume) {
            resolveResume();
            resolveResume = null;
            pausePromise = null;
        }
        break;
    }
    case WorkerAction.Retry: {
        const {recipientKey, filesRecordList, bitmapArray} = payload;
        transferMissingChunks(bitmapArray, filesRecordList, recipientKey, async (chunk) => {
            await checkPause();

            const packet = new Uint8Array(encodeDataPayload({
                type: DataPayloadType.Chunk,
                data: chunk,
            })).buffer;
            const response: WorkerResponse = {
                action: WorkerAction.GetEncryptedChunk,
                status: "SUCCESS",
                result: {packet, chunkId: chunk.chunkId, fileId: chunk.fileId},
            };
            self.postMessage(response, [packet, chunk.ciphertext.buffer]);

            await waitForBackpressureReady();
        });
    }
  }
};

async function initFileRecordList(
    fileHandleList: FileSystemFileHandle[],
    signingKeyPair: CryptoKeyPair,
): Promise<SenderFileRecord[]> {
    const metadatList: SenderFileRecord[] = [];
    for (let fileId = 0; fileId < fileHandleList.length; fileId++) {
        const fileHandle = fileHandleList[fileId];
        const ephemeralKeyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
            true,
        ["deriveKey"]
        );
        const fileRecord = await initFileRecord(fileId, fileHandle, signingKeyPair, ephemeralKeyPair);
        metadatList.push(fileRecord);
    }

    return metadatList;
}

async function initFileRecord(
    fileId: number,
    fileHandle: FileSystemFileHandle,
    signingKeyPair: CryptoKeyPair,
    ephemeralKeyPair: CryptoKeyPair,
): Promise<SenderFileRecord> {
    let file: File | null = await fileHandle.getFile();
    const fileSize = file.size;
    const fileName = file.name;
    const fileType = file.type;

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    const sizer = createFixedSizer(CHUNK_SIZE);
    const chunkStream = file.stream().pipeThrough(sizer);
    const reader = chunkStream.getReader();

    const leafHashes = new Uint8Array(totalChunks * 32);

    let i = 0;
    try {
        while (true) {
            const {value, done} = await reader.read();
            if (done) {
                break;
            }
        
            const hash = await crypto.subtle.digest('SHA-256', value);
            leafHashes.set(new Uint8Array(hash), i * 32);

            i++;
        }
    } finally {
        reader.releaseLock();
    }

    // const rootHash = await buildRoot(leafHashes);
    const rootHash = await calculateFileHash(file);
    const hashBuffer = rootHash.buffer as ArrayBuffer;
    
    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signingKeyPair.privateKey,
        hashBuffer
    );

    console.log(new Uint8Array(await file.arrayBuffer()))

    const ephemeralPublicKey = await crypto.subtle.exportKey("spki", ephemeralKeyPair.publicKey);

    return {
        id: fileId,
        leafHashes: leafHashes,
        fileHandle: fileHandle,
        ephemeralKeyPair: ephemeralKeyPair,
        fileMetadata: {
            fileId: fileId,
            rootHash: rootHash,
            signature: new Uint8Array(signature),
            ephemeralPublicKey: new Uint8Array(ephemeralPublicKey),
            totalChunks: totalChunks,
            fileInfo: {
                fileSize: fileSize,
                fileType: fileType,
                fileName: fileName,
            }
        }
    };
}

function createFixedSizer(pageSize: number) {
  let buffer = new Uint8Array(0);

  return new TransformStream({
    transform(chunk, controller) {
      const nextBuffer = new Uint8Array(buffer.length + chunk.length);
      nextBuffer.set(buffer);
      nextBuffer.set(chunk, buffer.length);
      buffer = nextBuffer;

      let offset = 0;
      while (offset + pageSize <= buffer.length) {
        controller.enqueue(buffer.slice(offset, offset + pageSize));
        offset += pageSize;
      }

      buffer = buffer.slice(offset);
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(buffer);
      }
      buffer = new Uint8Array(0);
    }
  });
}

async function transferChunks(recipientEncryptionKey: CryptoKey, filesRecordList: SenderFileRecord[], onChunk: (chunk: ChunkPayload) => Promise<void>) {
    for (const fileRecord of filesRecordList) {
        await processFileToChunks(
            fileRecord.fileHandle,
            0,
            fileRecord.fileMetadata.fileId,
            fileRecord.leafHashes,
            recipientEncryptionKey,
            fileRecord.ephemeralKeyPair,
            onChunk
        );
    }

    const message: WorkerResponse = {
        action: WorkerAction.SendForRetry,
        result: undefined,
        error: undefined,
        status: undefined,
    }
    self.postMessage(message);
}

async function processFileToChunks(
  fileHandle: FileSystemFileHandle, 
  chunkId: number,
  fileId: number,
  //@ts-ignore
  leafHashes: Uint8Array,
  recipientKey: CryptoKey,
  ephemeralKeyPair: CryptoKeyPair,
  onChunk: (chunk: ChunkPayload) => Promise<void>
) {
  const file = await fileHandle.getFile();
  const reader = file.stream().pipeThrough(createFixedSizer(CHUNK_SIZE)).getReader();
  
  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: recipientKey },
    ephemeralKeyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const encrypted = await encryptJustChunk(aesKey, value);

            const payload: ChunkPayload = {
               fileId: fileId,
               chunkId: chunkId++,
               ciphertext: new Uint8Array(encrypted.ciphertext),
               iv: new Uint8Array(encrypted.iv)
            };
            await onChunk(payload);
    }
  } finally {
    reader.releaseLock();
  }
}

async function transferMissingChunks(
    chunksBitmap: Uint8Array[],
    filesRecordList: SenderFileRecord[],
    reciepientKey: CryptoKey,
    onChunk: (chunk: ChunkPayload) => Promise<void>,
) {
    console.log("here transferMissingChunks");
    for (let fileId = 0; fileId < chunksBitmap.length; fileId++) {
        const file = await filesRecordList[fileId].fileHandle.getFile();
        const ephemeralKeyPair = filesRecordList[fileId].ephemeralKeyPair;
        const totalChunks = filesRecordList[fileId].fileMetadata.totalChunks;
        const missingChunksIdList = getMissingChunks(chunksBitmap[fileId], totalChunks);
        console.log("here transferMissingChunks", missingChunksIdList);
        const aesKey = await crypto.subtle.deriveKey(
            { name: "ECDH", public: reciepientKey },
            ephemeralKeyPair.privateKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt"]
        );

        for (const chunkId of missingChunksIdList) {
            const start = chunkId * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = await file.slice(start, end).arrayBuffer();

            const encrypted = await encryptJustChunk(aesKey, chunk);

            const payload: ChunkPayload = {
               fileId: fileId,
               chunkId: chunkId,
               ciphertext: new Uint8Array(encrypted.ciphertext),
               iv: new Uint8Array(encrypted.iv)
            };
            await onChunk(payload);
        }
    }

    const message: WorkerResponse = {
        action: WorkerAction.SendForRetry,
        result: undefined,
        error: undefined,
        status: undefined,
    }
    self.postMessage(message);
}