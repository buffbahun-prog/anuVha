import { createPeerConnection } from "./webrtc";
import { CHUNK_SIZE} from "./transfer";
import { TransferState, type ChunkAck, type DataPayload, type FileInfo, type PauseStatus, type Sample, type Status, type TransferEvents } from "../types";
import { compressEncryptSign, generateSigningKeyPair } from "../crypto/encryption";
import { arrayBufferToBase64, calculateSpeed, compressJSON, createChunkBitmap, cryptoKeyToBase64, decompressJSON, getMissingChunks, importECDHPublicKey, isBitmapComplete, isChunkReceived, setChunkReceived, uint8ToBase64 } from "../utils/convert";
import { TypedEmitter } from "./emmiter";

interface FileInfoWithHandle {
  fileInfo: FileInfo;
  fileHandle: FileSystemFileHandle
}

export class Sender extends TypedEmitter<TransferEvents> {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel;
  private localKeys: CryptoKeyPair | null = null;
  private recipientKey: CryptoKey | null = null;

  private fileHandles: FileSystemFileHandle[];
  private fileInfoList: FileInfoWithHandle[] | null = null;
  static CHUNK_SIZE = 128 * 1024;

  private pauseState: Record<"local" | "remote", PauseStatus> = {
    local: {
      pause: false,
      from: "sender",
      resumeFromFileIndex: 0,
      resumeFromChunkIndex: 0,
    },
    remote: {
      pause: false,
      from: "reciever",
      resumeFromFileIndex: 0,
      resumeFromChunkIndex: 0,
    },
  };
  
  private localPauseAck = false;
  private senderKeyAck = false;
  private fileInfoAck = false;
  private completeAck = false;

  private currentFileIndex = 0;
  private currentChunkIndex = 0;

  private isSending = false;

  private transferState: TransferState = TransferState.Idel;

  private chunksBitmapArray: Uint8Array[] | null = null;

  private chunkRecieved = 0;

  private samples: Sample[] = [];

  constructor() {
    super();
    this.pc = createPeerConnection();
    this.dataChannel = this.pc.createDataChannel("fileTransfer");
    this.dataChannel.bufferedAmountLowThreshold = 512 * 1024;
    this.fileHandles = [];

    this.setState(TransferState.Idel);

    this.dataChannel.onopen = async () => {
      this.setState(TransferState.Handshaking);
    }

    this.dataChannel.onmessage = async (event) => {
      const dataPayload = JSON.parse(event.data) as DataPayload;
      this.onDataMessageRecieve(dataPayload);
    }
  }

  getisPaused() {
    return this.pauseState.local.pause;
  }

  private setState(state: TransferState) {
    if (state === this.transferState) return;
    this.transferState = state;
    this.emit("stateChange", {state: state});
    switch (state) {
      case TransferState.Connecting: {
        this.currentFileIndex = 0;
        this.currentChunkIndex = 0;
        return;
      } case TransferState.Handshaking: {
        this.senderSigningKeySend();
        this.fileInfoSend();
        return;
      } case TransferState.Transferring: {
        this.onTransfer();
        return;
      } case TransferState.Paused: {
        return;
      } case TransferState.Completed: {
        this.sendUntilAck("status", {type: "complete", ok: true}, () => this.completeAck);
      }
    }
  }

  static async initConnection(): Promise<Sender> {
    const sender = new Sender();

    await sender.initConnection();
    // await sender.initFiles();
    // sender.initChunksBitmap();
    sender.localKeys = await generateSigningKeyPair();
    return sender;
  }

  async getDescriptorJSON(): Promise<string> {
    if (!this.pc.localDescription) {
      throw new Error("Local description not set");
    }

    if (this.pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const checkState = () => {
          if (this.pc.iceGatheringState === "complete") {
            this.pc.removeEventListener("icegatheringstatechange", checkState);
            resolve();
          }
        };
        this.pc.addEventListener("icegatheringstatechange", checkState);
      });
    }
    return compressJSON({ sdp: this.pc.localDescription });
  }

  async setRemoteDescriptor(remoteDescriptorJSON: string): Promise<void> {
    const data = decompressJSON(remoteDescriptorJSON);
    await this.pc.setRemoteDescription(data.sdp);
  }

  onLocalPause(isPaused: boolean) {
    this.pauseState.local.pause = isPaused;
    this.pauseState.local.resumeFromFileIndex = this.currentFileIndex;
    this.pauseState.local.resumeFromChunkIndex = this.currentChunkIndex;
    this.pauseInfoSend();
    if (isPaused === true) {
      this.setState(TransferState.Paused);
    }
    else this.updatePauseState();
  }

  private async initConnection(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.setState(TransferState.Connecting);
  }


  async initFiles(fileHandles: FileSystemFileHandle[]) {
    if (fileHandles.length <= 0) {
      throw new Error("No files selected");
    }
    this.fileHandles = fileHandles;
    this.fileInfoList = await Promise.all(this.fileHandles.map(async (handle, index) => {
      const file = await handle.getFile();
      return {
        fileHandle: handle,
        fileInfo: {
          fileId: index,
          name: file.name,
          fileSize: file.size,
          fileType: file.type,
          total: Math.ceil(file.size / CHUNK_SIZE),
        }
      }
    }));

    this.initChunksBitmap();

    this.emit("fileInfo", {
      files: this.fileInfoList.map(infoLst => infoLst.fileInfo)
    });
  }

  private onTransfer() {
    if (this.transferState !== TransferState.Transferring) return;
    const startFromFileId = this.currentFileIndex;
    const startFromChunkId = this.currentChunkIndex;

    this.transferFiles(startFromFileId, startFromChunkId);
  }

  private async senderSigningKeySend() {
    if (!this.localKeys) throw new Error("local keys pair not set.");
    const senderPub = await cryptoKeyToBase64(this.localKeys.publicKey);
    await this.sendUntilAck("senderSigningKey", senderPub, () => this.senderKeyAck);
  }

  private async fileInfoSend() {
    if (!this.fileInfoList || this.fileInfoList.length <= 0) {
      throw new Error("No files info found.");
    }
    const fileInfo = this.fileInfoList.map(info => info.fileInfo);

    await this.sendUntilAck("fileInfo", fileInfo, () => this.fileInfoAck);
  }

  private async pauseInfoSend() {
    const pauseInfo = this.pauseState.local;
    this.localPauseAck = false;
    this.emit("pause", {
      by: "local",
      paused: pauseInfo.pause,
    });
    this.sendUntilAck("pauseInfo", pauseInfo, () => this.localPauseAck);
  }

  private updatePauseState() {
    if (!this.pauseState.local.pause && !this.pauseState.remote.pause) {
      this.setState(TransferState.Transferring);
    }
  }

  private onRemotePause(remotePauseInfo: PauseStatus) {
    this.pauseState.remote = remotePauseInfo;
    this.currentFileIndex = this.pauseState.remote.resumeFromFileIndex;
    this.currentChunkIndex = this.pauseState.remote.resumeFromChunkIndex;
    console.log(this.currentChunkIndex, this.currentFileIndex);
    this.dataChannel.send(JSON.stringify({type: "status", data: {ok: true, type: "pause"}}));
    this.emit("pause", {
      by: "remote",
      paused: remotePauseInfo.pause,
    });
    if (remotePauseInfo.pause === true) {
      this.setState(TransferState.Paused);
    }
    else this.updatePauseState();
  }

  private onStatusMessage(type: Status["type"]) {
    switch (type) {
      case "senderSigningKey": {
        this.senderKeyAck = true;
        break;
      } case "fileInfo": {
        this.fileInfoAck = true;
        break;
      } case "pause": {
        this.localPauseAck = true;
        return;
      } case "complete": {
        this.completeAck = true;
        return;
      }
    }
    this.tryAdvanceHandshake();
  }

  private tryAdvanceHandshake() {
    if (this.senderKeyAck && this.fileInfoAck && this.recipientKey) {
      this.setState(TransferState.Transferring);
    }
  }

  private async onRecipientKeyMessage(recipientKey: string) {
    this.recipientKey = await importECDHPublicKey(recipientKey);
    this.dataChannel.send(JSON.stringify({ type: "status", data: { ok: true, type: "recipientEncryptionKey" } }));
  }

  private async onDataMessageRecieve(dataPayload: DataPayload) {
    const {data, type} = dataPayload;
    switch (type) {
      case "recipientEncryptionKey": {
        await this.onRecipientKeyMessage(data as string);
        this.tryAdvanceHandshake();
        return;
      } case "pauseInfo": {
        this.onRemotePause(data as PauseStatus);
        return;
      } case "chunkAck": {
        this.onChunkAckRecieve(data as ChunkAck);
        return;
      } case "status": {
        const statusMessage = data as Status;
        if (!statusMessage.ok) return;
        this.onStatusMessage(statusMessage.type);
        return;
      }
    }
  }

  private onChunkAckRecieve(chunkInfo: ChunkAck) {
    if (!this.chunksBitmapArray || this.chunksBitmapArray.length <= 0) throw new Error("chunkBitmap not initialized properly");
    const {fileId, chunkId} = chunkInfo;
    if (isChunkReceived(this.chunksBitmapArray, fileId, chunkId)) return;
    this.samples.push({
        bytes: Sender.CHUNK_SIZE,
        time: performance.now()
    });
    const speed = calculateSpeed(this.samples);
    this.emit("speed", {
      bytesPerSecond: speed
    });
    this.chunkRecieved++;
    setChunkReceived(this.chunksBitmapArray[fileId], chunkId);

    if (!this.fileInfoList) return;
    const totalChunks = this.fileInfoList.reduce((acc, cur) => acc + cur.fileInfo.total, 0);
    const ackProgress = (this.chunkRecieved / totalChunks) * 100;
    this.emit("progress", {
      percent: ackProgress,
      totalChunks: totalChunks,
    });
  }

  private async transferFiles(fromFileId: number, fromChunkId: number) {
    try {
      if (this.isSending) return;
      this.isSending = true;

      if (!(this.localKeys && !!this.recipientKey && Array.isArray(this.fileInfoList) && this.fileInfoList.length > 0)) 
        throw new Error("All info before file transfer not fulfilled.")

      const currentFileInfoList = this.fileInfoList.slice(fromFileId);

      for (const fileInfo of currentFileInfoList) {
        const fileId = fileInfo.fileInfo.fileId;
        const file = await fileInfo.fileHandle.getFile();
        const totalFileChunks = fileInfo.fileInfo.total;

        for (let chunkId = fromChunkId; chunkId < totalFileChunks; chunkId++) {

          if (this.transferState === TransferState.Paused || this.transferState === TransferState.Closed) return;

          await this.sendChunk(fileId, chunkId, file);
        }

        fromChunkId = 0;
        this.currentFileIndex = fileId;
      }

      this.setState(TransferState.Retry);
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      await delay(100);
      await this.sendMissingChunks();

    } finally {
      this.isSending = false;
    }
  }

  private async sendChunk(fileId: number, chunkId: number, file: File) {
    if (!this.localKeys || !this.recipientKey)
      throw new Error("Local keys or reciepientKeys value not set.");

    const startIndex = chunkId * Sender.CHUNK_SIZE;
    const endIndex = Math.min(startIndex + Sender.CHUNK_SIZE, file.size);

    const chunkBuffer = await file.slice(startIndex, endIndex).arrayBuffer();

    const payload = await compressEncryptSign(
      this.localKeys,
      this.recipientKey,
      chunkBuffer
    );
          // console.log("chunk", chunkId);
    await this.sendWithBackpressure(
      JSON.stringify({
        type: "chunk",
        data: {
          fileId,
          index: chunkId,
          ciphertext: arrayBufferToBase64(payload.ciphertext),
          ephemeralPublicKey: arrayBufferToBase64(payload.ephemeralPublicKey),
          signature: arrayBufferToBase64(payload.signature),
          iv: uint8ToBase64(payload.iv),
        },
      })
    );

    this.currentChunkIndex = chunkId;
  }

  private initChunksBitmap() {
    this.chunksBitmapArray = this.fileInfoList?.
                              map(info => createChunkBitmap(info.fileInfo.total)) 
                              ?? null;
  }

  private async sendMissingChunks() {
    if (!this.chunksBitmapArray || !this.fileInfoList) return;
    while (!this.isChunksTransferComplete()) {
      if (this.dataChannel.readyState !== "open" || this.transferState === TransferState.Closed) return;
      for (const [fileId, bitmap] of this.chunksBitmapArray.entries()) {
        const totaChunks = this.fileInfoList[fileId].fileInfo.total;
        const file = await this.fileInfoList[fileId].fileHandle.getFile();
        const missingChunkIdList = getMissingChunks(bitmap, totaChunks);
        for (let chunkId of missingChunkIdList) {
          await this.sendChunk(fileId, chunkId, file);
        }
      }
      await new Promise(r => setTimeout(r, 50));
    }
    this.setState(TransferState.Completed);
  }

  private isChunksTransferComplete() {
    if (!this.chunksBitmapArray || this.chunksBitmapArray.length <= 0) throw new Error("chunkBitmap not initialized properly");
    return this.chunksBitmapArray.every(bitmap => isBitmapComplete(bitmap));
  }

  private async sendUntilAck(type: DataPayload["type"], payload: DataPayload["data"], checkAck: () => boolean) {
    let retries = 0;
    const MAX_RETRIES = 20;
    while (retries < MAX_RETRIES) {
      if (checkAck()) return;
      if (this.dataChannel.readyState !== "open") return;
      this.dataChannel.send(JSON.stringify({ type, data: payload }));
      const delay = 300 * Math.pow(2, retries);
      await new Promise((r) => setTimeout(r, delay));
      retries++;
    }

    throw new Error("Ack timeout");
  }

  private async sendWithBackpressure(data: string) {
    if (this.dataChannel.bufferedAmount > this.dataChannel.bufferedAmountLowThreshold) {
      await new Promise<void>((res) => {
        const handler = () => {
          this.dataChannel.removeEventListener("bufferedamountlow", handler);
          res();
        };
        this.dataChannel.addEventListener("bufferedamountlow", handler);
      });
    }
    this.dataChannel.send(data);
  }

  cleanup() {
    this.setState(TransferState.Closed);    

    // 1. Stop sending
    this.isSending = false;

    // 2. Close data channel
    if (this.dataChannel) {
      this.dataChannel.onmessage = null;
      this.dataChannel.onopen = null;
      this.dataChannel.close();
    }

    // 3. Close peer connection
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.close();
    }

    // 4. Clear memory
    this.chunksBitmapArray = null;
    this.fileInfoList = null;
    this.samples = [];

    // 5. Clear crypto
    this.localKeys = null;
    this.recipientKey = null;

    // 6. Dispatch final event
    this.emit("closed", {isClosed: true});
  }
}