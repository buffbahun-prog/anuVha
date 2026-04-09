import { createPeerConnection } from "./webrtc";
import { RecieveState, type ChunkAck, type ChunkPayload, type DataPayload, type FileInfo, type PauseStatus, type Sample, type Status, type TransferEvents } from "../types";
import { base64ToArrayBuffer, base64ToUint8, calculateSpeed, compressJSON, createChunkBitmap, cryptoKeyToBase64, decompressJSON, importECDSAPublicKey, isBitmapComplete, isChunkReceived, setChunkReceived } from "../utils/convert";
import { decryptVerifyDecompress, generateEncryptionKeyPair } from "../crypto/encryption";
import { TypedEmitter } from "./emmiter";


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
      resumeFromFileIndex: 0,
      resumeFromChunkIndex: 0,
  };

  private chunksBitmapArray: Uint8Array[] | null = null;

  constructor() {
    super();
    this.pc = createPeerConnection();

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupChannel();
    }
  }

  private setupChannel() {
    if (!this.dataChannel) throw new Error("data channel not initialized properly.");
    this.dataChannel.onmessage = async (event) => {
      const dataPayload = JSON.parse(event.data) as DataPayload;
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

  private setState(state: RecieveState) {
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
        if (this.isChunksTransferComplete() && this.opfsRoot) {
          this.emit("complete", {opfs: this.opfsRoot})
          this.closeWriteStream();
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
      const recieverPub = await cryptoKeyToBase64(this.localKeys.publicKey);
      await this.sendUntilAck("recipientEncryptionKey", recieverPub, () => this.recieverKeyAck);
  }

  private async sendUntilAck(type: DataPayload["type"], payload: DataPayload["data"], checkAck: () => boolean) {
    if (!this.dataChannel) throw new Error("data channel not initialized properly.");
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

  private async onSenderKeyMessage(senderKey: string) {
    if (!this.dataChannel) throw new Error("data channel not initialized properly.");
    this.senderKey = await importECDSAPublicKey(senderKey);
    this.dataChannel.send(JSON.stringify({ type: "status", data: { ok: true, type: "senderSigningKey" } as Status }));
  }

  onLocalPause(isPaused: boolean) {
    this.pauseState.pause = isPaused;
    this.pauseState.resumeFromFileIndex = this.currentFileIndex;
    this.pauseState.resumeFromChunkIndex = this.currentChunkIndex;
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
    this.dataChannel.send(JSON.stringify({type: "status", data: {ok: true, type: "pause"}}))
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
    this.sendUntilAck("pauseInfo", pauseInfo, () => this.localPauseAck);
  }

  private async onDataMessageRecieve(dataPayload: DataPayload) {
    const {data, type} = dataPayload;
    switch (type) {
      case "senderSigningKey": {
        await this.onSenderKeyMessage(data as string);
        break;
      } case "fileInfo": {
        this.onFileInfoRecieved(data as FileInfo[]);
        break;
      } case "pauseInfo": {
        this.onRemotePause(data as PauseStatus);
        return;
      } case "chunk": {
        this.onChunkRecieve(data as ChunkPayload);
        return;
      } case "status": {
        const statusMessage = data as Status;
        if (!statusMessage.ok) return;
        this.onStatusMessage(statusMessage.type);
        return;
      }
    }

    this.tryAdvanceHandshake();
  }

  private onStatusMessage(type: Status["type"]) {
    switch (type) {
      case "recipientEncryptionKey": {
        this.recieverKeyAck = true;
        break;
      } case "pause": {
        this.localPauseAck = true;
        return;
      } case "complete": {
        this.setState(RecieveState.Completed);
        this.dataChannel?.send(JSON.stringify({type: "status", data: {type: "complete", ok: true}} as DataPayload))
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

  private async onFileInfoRecieved(infoList: FileInfo[]) {
    if (!this.dataChannel) throw new Error("All info before file init not fulfilled.")
    if (!infoList.length) return;
    this.fileWriters = new Array(infoList.length);
    this.opfsRoot = await navigator.storage.getDirectory();
    this.dataChannel.send(JSON.stringify({type: "status", data: {ok: true, type: "fileInfo"}}));
    this.filesInfo = infoList;
    
    // 2. Prepare the Disk Writers for each file
    for (const info of this.filesInfo) {
      const fileHandle = await this.opfsRoot.getFileHandle(info.name, { create: true })
      this.fileWriters[info.fileId] = await fileHandle.createWritable({ keepExistingData: true });
    }

    this.initChunksBitmap();
    
    this.emit("fileInfo", {
      files: infoList
    });
  }

  private initChunksBitmap() {
      this.chunksBitmapArray = this.filesInfo?.
                                map(info => createChunkBitmap(info.total)) 
                                ?? null;
  }

  private async onChunkRecieve(chunk: ChunkPayload) {

    if (!this.dataChannel || !this.chunksBitmapArray || !this.senderKey || !this.localKeys || !this.filesInfo || !this.fileWriters ) throw new Error("All info before file recieve not fulfilled.")

    if (isChunkReceived(this.chunksBitmapArray, chunk.fileId, chunk.index)) {
      return;
    }
    
      const decrypted = await decryptVerifyDecompress(
      this.senderKey,
      this.localKeys,
      {
        ciphertext: base64ToArrayBuffer(chunk.ciphertext),
        iv: base64ToUint8(chunk.iv),
        signature: base64ToArrayBuffer(chunk.signature),
        ephemeralPublicKey: base64ToArrayBuffer(chunk.ephemeralPublicKey)
      }
      );

      this.currentFileIndex = chunk.fileId;
      this.currentChunkIndex = chunk.index;

      const offset = chunk.index * Reciever.CHUNK_SIZE;

      await this.fileWriters[chunk.fileId].write({
        type: "write",
        position: offset,
        data: decrypted.buffer as ArrayBuffer // Cast to satisfy TS
      });


    const chunkInfo: ChunkAck = {
      fileId: chunk.fileId,
      chunkId: chunk.index,
    }

    this.dataChannel.send(JSON.stringify({
      type: "chunkAck",
      data: chunkInfo
    } as DataPayload));

    this.updateChunkBitmap(chunkInfo);
      
    this.recieved++;

    const fileInfo = this.filesInfo[chunk.fileId];
    // Update pause indices
    if (chunk.index + 1 >= fileInfo.total) {
      this.pauseState.resumeFromFileIndex = chunk.fileId + 1;
      this.pauseState.resumeFromChunkIndex = 0;
    } else {
      this.pauseState.resumeFromFileIndex = chunk.fileId;
      this.pauseState.resumeFromChunkIndex = chunk.index + 1;
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