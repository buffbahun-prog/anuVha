import { createPeerConnection } from "./webrtc";
import { DataPayloadType, RecieveState, StatusType, type ChunkAck, type ChunkPayload, type DataPayload, type FileInfo, type FileMetadata, type PauseStatus, type Sample, type Status, type TransferEvents } from "../types";
import { calculateSpeed, compressJSON, createChunkBitmap, decompressJSON, importECDSAPublicKey, isBitmapComplete, isChunkReceived, setChunkReceived } from "../utils/convert";
import { decryptVerifyDecompress, generateEncryptionKeyPair } from "../crypto/encryption";
import { TypedEmitter } from "./emmiter";
import { decodeChunkPayload, decodeFileMetadataList, decodePauseStatus, decodeStatusMessage, encodeDataPayload } from "./transfer";
import { verifyFileHash } from "../crypto/hasher";


export class Reciever extends TypedEmitter<TransferEvents> {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private localKeys: CryptoKeyPair | null = null;
  private senderKey: CryptoKey | null = null;
  private filesInfo: FileInfo[] | null = null;

  private opfsRoot: FileSystemDirectoryHandle | null = null;
  private fileWriters: FileSystemWritableFileStream[] | null = null;

  private samples: Sample[] = [];

  private recieverKeyAck = false;
  private localPauseAck = false;

  static CHUNK_SIZE = 128 * 1024;

  private recieveState: RecieveState = RecieveState.Idel;

  private currentFileIndex = 0;
  private currentChunkIndex = 0;

  private recieved = 0;

  private pauseState: PauseStatus = {
      pause: false,
      from: "reciever",
      resumeFromFileId: 0,
      resumeFromChunkId: 0,
  };

  private chunksBitmapArray: Uint8Array[] | null = null;

  constructor() {
    super();
    this.pc = createPeerConnection();

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.dataChannel.binaryType = "arraybuffer";
      this.setupChannel();
    }
  }

  private setupChannel() {
    if (!this.dataChannel) throw new Error("data channel not initialized properly.");
    this.dataChannel.onmessage = async (event) => {
      const dataPayload = new Uint8Array(event.data);
      this.onDataMessageRecieve(dataPayload);
    };

    this.dataChannel.onopen = () => {
      this.setState(RecieveState.Handshaking);
    };
  }

  static async initConnection(): Promise<Reciever> {
    const reciever = new Reciever();

    reciever.localKeys = await generateEncryptionKeyPair();
    return reciever;
  }

  private async initConnection(): Promise<void> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.setState(RecieveState.Connecting);
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
    await this.initConnection();
  }

  private async setState(state: RecieveState) {
    if (state === this.recieveState) return;
    this.recieveState = state;
    this.emit("stateChange", {state: state});
    switch (state) {
      case RecieveState.Connecting: {
        return;
      } case RecieveState.Handshaking: {
        this.recieverEncryptionKeySend();
        return;
      } case RecieveState.Recieveing: {
        return;
      } case RecieveState.Paused: {
        return;
      } case RecieveState.Completed: {
        console.log("here");
        if (this.isChunksTransferComplete() && this.opfsRoot && this.filesInfo) {
          await this.closeWriteStream();
          for (const info of this.filesInfo) {
            const fileHandle = await this.opfsRoot.getFileHandle(info.name);
            const file = await fileHandle.getFile();
            const hasSameHash = await verifyFileHash(file, info.fileHash);
            if (!hasSameHash) {
              console.error(file.name, "No Hash match");
            this.emit("error", new Error(`File hash not matched: ${file.name}`));
            return;
            }
          }
          this.emit("complete", {opfs: this.opfsRoot})
        }
      }
    }
  }

  private async closeWriteStream() {
    if (!this.fileWriters) return;
    for (const writer of this.fileWriters) {
      await writer.close();
    }
  }

  private async recieverEncryptionKeySend() {
      if (!this.localKeys) throw new Error("local keys pair not set.");
      const keyBuffer = await crypto.subtle.exportKey("spki", this.localKeys.publicKey);
      const recieverPub = new Uint8Array(keyBuffer);
      await this.sendUntilAck(DataPayloadType.RecipientEncryptionKey, recieverPub, () => this.recieverKeyAck);
  }

  private async sendUntilAck(type: DataPayload["type"], payload: DataPayload["data"], checkAck: () => boolean) {
    if (!this.dataChannel) throw new Error("data channel not initialized properly.");
    let retries = 0;
    const MAX_RETRIES = 20;
    while (retries < MAX_RETRIES) {
      if (checkAck()) return;
      if (this.dataChannel.readyState !== "open") return;
      const packet = encodeDataPayload({
        type: type,
        data: payload,
      } as DataPayload);
      if (!packet) return;
      this.dataChannel.send(packet.buffer as ArrayBuffer);
      const delay = 300 * Math.pow(2, retries);
      await new Promise((r) => setTimeout(r, delay));
      retries++;
    }

    throw new Error("Ack timeout");
  }

  private async onSenderKeyMessage(senderKey: Uint8Array) {
    if (!this.dataChannel) throw new Error("data channel not initialized properly.");
    this.senderKey = await importECDSAPublicKey(senderKey);
    const packet = encodeDataPayload({ type: DataPayloadType.Status, data: { ok: true, type: StatusType.SenderSigningKey } });
    if (!packet) return;
    this.dataChannel.send(packet.buffer as ArrayBuffer);
  }

  onLocalPause(isPaused: boolean) {
    this.pauseState.pause = isPaused;
    this.pauseState.resumeFromFileId = this.currentFileIndex;
    this.pauseState.resumeFromChunkId = this.currentChunkIndex;
    this.pauseInfoSend();
    if (isPaused === true) {
      this.setState(RecieveState.Paused);
    }
    else this.updatePauseState();
  }

  private updatePauseState() {
    if (!this.pauseState.pause) {
      this.setState(RecieveState.Recieveing);
    }
  }

  private onRemotePause(remotePauseInfo: PauseStatus) {
    if (!this.dataChannel) throw new Error("data channel not initialized properly.");
    const packet = encodeDataPayload({type: DataPayloadType.Status, data: {ok: true, type: StatusType.Pause}});
    if (!packet) return;
    this.dataChannel.send(new Uint8Array(packet).buffer);
    this.emit("pause", {
      by: "remote",
      paused: remotePauseInfo.pause,
    });
  }

  private async pauseInfoSend() {
    const pauseInfo = this.pauseState;
    this.localPauseAck = false;
    this.emit("pause", {
      by: "local",
      paused: pauseInfo.pause,
    });
    this.sendUntilAck(DataPayloadType.PauseInfo, pauseInfo, () => this.localPauseAck);
  }

  private async onDataMessageRecieve(dataPayload: Uint8Array) {
    const type = dataPayload[0];
    const data = dataPayload.subarray(1);
    switch (type) {
      case DataPayloadType.SenderSigningKey: {
        await this.onSenderKeyMessage(data);
        break;
      } case DataPayloadType.FileInfo: {
        const decoded = decodeFileMetadataList(data);
        this.onFileInfoRecieved(decoded);
        break;
      } case DataPayloadType.PauseInfo: {
        const decoded = decodePauseStatus(data);
        this.onRemotePause(decoded);
        return;
      } case DataPayloadType.Chunk: {
        const decoded = decodeChunkPayload(data);
        this.onChunkRecieve(decoded);
        return;
      } case DataPayloadType.Status: {
        const statusMessage = decodeStatusMessage(data);
        if (!statusMessage.ok) return;
        this.onStatusMessage(statusMessage.type);
        return;
      }
    }

    this.tryAdvanceHandshake();
  }

  private onStatusMessage(type: Status["type"]) {
    switch (type) {
      case StatusType.RecipientEncryptionKey: {
        this.recieverKeyAck = true;
        break;
      } case StatusType.Pause: {
        this.localPauseAck = true;
        return;
      } case StatusType.Complete: {
        this.setState(RecieveState.Completed);
        const packet = encodeDataPayload({type: DataPayloadType.Status, data: {type: StatusType.Complete, ok: true}});
        if (!packet) return;
        this.dataChannel?.send(packet.buffer as ArrayBuffer)
        return;
      }
    }
    this.tryAdvanceHandshake();
  }

  private tryAdvanceHandshake() {
    if (this.recieverKeyAck && this.filesInfo && this.senderKey) {
      this.setState(RecieveState.Recieveing);
    }
  }

  private async onFileInfoRecieved(infoList: FileMetadata[]) {
    if (!this.dataChannel) throw new Error("All info before file init not fulfilled.")
    if (!infoList.length) return;
    this.fileWriters = new Array(infoList.length);
    this.opfsRoot = await navigator.storage.getDirectory();
    this.filesInfo = infoList.map(infoLst => ({
                  name: infoLst.fileInfo.fileName,
                  total: infoLst.totalChunks,
                  fileSize: infoLst.fileInfo.fileSize,
                  fileType: infoLst.fileInfo.fileType,
                  fileId: infoLst.fileId,
                  ephemeralPublicKey: infoLst.ephemeralPublicKey,
                  fileHash: infoLst.rootHash,
                }));
    
    // 2. Prepare the Disk Writers for each file
    for (const info of this.filesInfo) {
      const fileHandle = await this.opfsRoot.getFileHandle(info.name, { create: true })
      this.fileWriters[info.fileId] = await fileHandle.createWritable({ keepExistingData: true });
    }

    const packet = encodeDataPayload({type: DataPayloadType.Status, data: {ok: true, type: StatusType.FileInfo}});
    if (!packet) return;
    this.dataChannel.send(new Uint8Array(packet).buffer);

    this.initChunksBitmap();
    
    this.emit("fileInfo", {
      files: this.filesInfo
    });
  }

  private initChunksBitmap() {
      this.chunksBitmapArray = this.filesInfo?.
                                map(info => createChunkBitmap(info.total)) 
                                ?? null;
  }

  private async onChunkRecieve(chunk: ChunkPayload) {

    if (!this.dataChannel || !this.chunksBitmapArray || !this.senderKey || !this.localKeys || !this.filesInfo || !this.fileWriters ) throw new Error("All info before file recieve not fulfilled.")

      const chunkInfo: ChunkAck = {
      fileId: chunk.fileId,
      chunkId: chunk.chunkId,
    }

    const chunkAckPacket = encodeDataPayload({
      type: DataPayloadType.ChunkAck,
      data: chunkInfo
    });
    if (chunkAckPacket) this.dataChannel.send(new Uint8Array(chunkAckPacket).buffer);

    if (isChunkReceived(this.chunksBitmapArray, chunk.fileId, chunk.chunkId)) {
      return;
    }
    
      const decrypted = await decryptVerifyDecompress(
      this.localKeys,
      {
        ciphertext: new Uint8Array(chunk.ciphertext).buffer,
        iv: chunk.iv,
        ephemeralPublicKey: new Uint8Array(this.filesInfo[chunk.fileId].ephemeralPublicKey).buffer
      }
      );

      this.currentFileIndex = chunk.fileId;
      this.currentChunkIndex = chunk.chunkId;

      const offset = chunk.chunkId * Reciever.CHUNK_SIZE;

      await this.fileWriters[chunk.fileId].write({
        type: "write",
        position: offset,
        data: decrypted.buffer as ArrayBuffer // Cast to satisfy TS
      });

    this.updateChunkBitmap(chunkInfo);
      
    this.recieved++;

    const fileInfo = this.filesInfo[chunk.fileId];
    // Update pause indices
    if (chunk.chunkId + 1 >= fileInfo.total) {
      this.pauseState.resumeFromFileId = chunk.fileId + 1;
      this.pauseState.resumeFromChunkId = 0;
    } else {
      this.pauseState.resumeFromFileId = chunk.fileId;
      this.pauseState.resumeFromChunkId = chunk.chunkId + 1;
    }

    this.samples.push({
      bytes: Reciever.CHUNK_SIZE,
      time: performance.now()
    });
    const speed = calculateSpeed(this.samples);
      this.emit("speed", {
        bytesPerSecond: speed
    });

    const totalChunks = this.filesInfo.reduce((acc, cur) => acc + cur.total, 0);
    const ackProgress = (this.recieved / totalChunks) * 100;
    this.emit("progress", {
      percent: ackProgress,
      totalChunks: totalChunks,
    });
  }

  private updateChunkBitmap(chunkInfo: ChunkAck) {
    if (!this.chunksBitmapArray || this.chunksBitmapArray.length <= 0) throw new Error("chunkBitmap not initialized properly");
    const {fileId, chunkId} = chunkInfo;
    setChunkReceived(this.chunksBitmapArray[fileId], chunkId);
  }

  private isChunksTransferComplete() {
      if (!this.chunksBitmapArray || this.chunksBitmapArray.length <= 0) throw new Error("chunkBitmap not initialized properly");
      return this.chunksBitmapArray.every(bitmap => isBitmapComplete(bitmap));
  }

  async cleanup() {
    this.setState(RecieveState.Closed);

    if (this.opfsRoot) {
      this.opfsRoot = null;
    }
    
    // 1. Close file writers
    if (this.fileWriters) {
      for (const writer of this.fileWriters) {
        try {
          await writer.close();
        } catch {}
      }
    }

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
    this.filesInfo = null;
    this.samples = [];

    // 5. Clear crypto
    this.localKeys = null;
    this.senderKey = null;

    this.emit("closed", {isClosed: true});
  }
}