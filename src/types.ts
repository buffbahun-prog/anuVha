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

export type Sample = { time: number; bytes: number };

export type ChunkPayload = {
  fileId: number;
  index: number;
  ciphertext: string;
  iv: string;
  signature: string;
  ephemeralPublicKey: string;
};

export type FileInfo = {
  fileId: number;
  name: string;
  total: number;
  fileSize: number;
  fileType: string;
};

export type Status = {
  ok: boolean;
  type: "recipientEncryptionKey" | "senderSigningKey" | "complete" | "fileInfo" | "pause";
};

export type PauseStatus = {
  pause: boolean;
  from: "sender" | "reciever";
  resumeFromFileIndex: number;
  resumeFromChunkIndex: number;
};

export interface ChunkAck {
    fileId: number;
    chunkId: number;
}

export interface DataPayload {
  data: ChunkPayload | string | FileInfo[] | Status | PauseStatus | ChunkAck;
  type:
    | "recipientEncryptionKey"
    | "senderSigningKey"
    | "chunk"
    | "status"
    | "fileInfo"
    | "pauseInfo"
    | "chunkAck";
}

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