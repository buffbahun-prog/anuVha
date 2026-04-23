export enum ConnectionType {
    Local,
    Global,
}

export enum PeerType {
    Sender,
    Reciever,
}

export enum ViewPage {
    TransferLanding,
    FilesUpload,
    QrExchangeShow,
    QrExchangeScan,
    FilesTransfer,
}

export enum CompressionType {
  Zstd = "zstd",
  Brotli = "brotli",
  Deflate = "deflate",
  DeflateRaw = "deflate-raw",
  Gzip = "gzip",
  None = "none",
}

export type Sample = { time: number; bytes: number };

export type ChunkPayload = {
  chunkId: number;
  fileId: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
};

export type FileInfo = {
  fileId: number;
  name: string;
  total: number;
  fileSize: number;
  fileType: string;
  ephemeralPublicKey: Uint8Array;
  fileHash: Uint8Array;
};

export interface SenderFileRecord {
  id: number;
  fileMetadata: FileMetadata;
  fileHandle: FileSystemFileHandle;
  ephemeralKeyPair: CryptoKeyPair;
  leafHashes: Uint8Array;
}

export interface FileMetadata {
    fileId: number;
    rootHash: Uint8Array;
    signature: Uint8Array;
    totalChunks: number;
    ephemeralPublicKey: Uint8Array;
    fileInfo: {
      fileSize: number;
      fileType: string;
      fileName: string;
    }
}

export enum StatusType {
  RecipientEncryptionKey = 0,
  SenderSigningKey = 1,
  Complete = 2,
  FileInfo = 3,
  Pause = 4,
}

export type Status = 
  | { type: StatusType.RecipientEncryptionKey; ok: boolean }
  | { type: StatusType.SenderSigningKey; ok: boolean }
  | { type: StatusType.Complete; ok: boolean }
  | { type: StatusType.FileInfo; ok: boolean }
  | { type: StatusType.Pause; ok: boolean; reason?: string };

export type PauseStatus = {
  pause: boolean;
  from: "sender" | "reciever";
  resumeFromFileId: number;
  resumeFromChunkId: number;
};

export interface ChunkAck {
    fileId: number;
    chunkId: number;
}

export enum DataPayloadType {
  SenderSigningKey = 0,
  RecipientEncryptionKey = 1,
  FileInfo = 2,
  Status = 3,
  Chunk = 4,
  ChunkAck = 5,
  PauseInfo = 6,
}

export type DataPayload =
  | { type: DataPayloadType.SenderSigningKey; data: Uint8Array } // Changed to Uint8Array for WebRTC
  | { type: DataPayloadType.RecipientEncryptionKey; data: Uint8Array }
  | { type: DataPayloadType.FileInfo; data: FileMetadata[] }
  | { type: DataPayloadType.Status; data: Status }
  | { type: DataPayloadType.Chunk; data: ChunkPayload }
  | { type: DataPayloadType.ChunkAck; data: ChunkAck }
  | { type: DataPayloadType.PauseInfo; data: PauseStatus };

export enum TransferState {
    Idel,
    Connecting,
    Handshaking,
    Transferring,
    Paused,
    Retry,
    Completed,
    Closed,
}

export enum RecieveState {
    Idel,
    Connecting,
    Handshaking,
    Recieveing,
    Paused,
    Retry,
    Completed,
    Closed,
}

export interface TransferEvents {
  stateChange: {
    state: TransferState | RecieveState;
  };

  fileInfo: {
    files: FileInfo[];
  };

  progress: {
    percent: number;
    totalChunks: number;
  };

  speed: {
    bytesPerSecond: number;
  };

  pause: {
    by: "local" | "remote";
    paused: boolean;
  };

  retry: {
    missingChunks: number;
  };

  complete: void | {opfs: FileSystemDirectoryHandle};

  error: Error;

  closed: {
    isClosed: true;
  };
}

export enum WorkerAction {
    GetMetadata,
    GetEncryptedChunk,
    NextChunkReady,
    Pause,
    Resume,
    SendForRetry,
    Retry,
}

export type WorkerRequest = { action: WorkerAction.GetMetadata; payload: FileMetadataPayload}
                          | {action: WorkerAction.GetEncryptedChunk; payload: {recipientKey: CryptoKey, filesRecordList: SenderFileRecord[]}}
                          | {action: WorkerAction.NextChunkReady; payload: undefined}
                          | {action: WorkerAction.Pause; payload: undefined}
                          | {action: WorkerAction.Resume; payload: undefined}
                          | {action: WorkerAction.Retry; payload: {recipientKey: CryptoKey, filesRecordList: SenderFileRecord[]; bitmapArray: Uint8Array[]}}

export type WorkerResponse = {action: WorkerAction.GetMetadata; status: 'SUCCESS' | 'ERROR'; result?: SenderFileRecord[]; error?: string}
                           | {action: WorkerAction.GetEncryptedChunk; status: 'SUCCESS' | 'ERROR'; result?: {packet: ArrayBuffer, chunkId: number, fileId: number}; error?: string}
                           | {action: WorkerAction.NextChunkReady; status: undefined; result: undefined, error: undefined}
                           | {action: WorkerAction.SendForRetry; status: undefined; result: undefined, error: undefined}

export interface FileMetadataPayload {
  fileHandleList: FileSystemFileHandle[],
  signingKeyPair: CryptoKeyPair;
}