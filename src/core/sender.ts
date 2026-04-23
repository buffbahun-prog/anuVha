import { createPeerConnection } from "./webrtc";
import { DataPayloadType, StatusType, TransferState, WorkerAction, type ChunkAck, type DataPayload, type FileMetadataPayload, type PauseStatus, type SenderFileRecord, type Status, type TransferEvents, type WorkerRequest, type WorkerResponse } from "../types";
import { generateSigningKeyPair } from "../crypto/encryption";
import { compressJSON, createChunkBitmap, decompressJSON, importECDHPublicKey, isBitmapComplete, isChunkReceived, setChunkReceived } from "../utils/convert";
import { TypedEmitter } from "./emmiter";
import { CHUNK_SIZE, decodeChunkAck, decodePauseStatus, decodeStatusMessage, encodeDataPayload } from "./transfer";
import { SpeedCalculator } from "./speedCalculator";

export class Sender extends TypedEmitter<TransferEvents> {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel;

  private worker: Worker;

  private localKeys: CryptoKeyPair | null = null;
  private recipientKey: CryptoKey | null = null;

  private fileHandleList: FileSystemFileHandle[];
  private filesRecordList: SenderFileRecord[] = [];

  private pauseState: Record<"local" | "remote", PauseStatus> = {
    local: {
      pause: false,
      from: "sender",
      resumeFromFileId: 0,
      resumeFromChunkId: 0,
    },
    remote: {
      pause: false,
      from: "reciever",
      resumeFromFileId: 0,
      resumeFromChunkId: 0,
    },
  };
  
  private localPauseAck = false;
  private senderKeyAck = false;
  private fileInfoAck = false;
  private completeAck = false;

  private currentFileIndex = 0;
  private currentChunkIndex = 0;

  private speedCalc: SpeedCalculator;

  private transferState: TransferState = TransferState.Idel;

  private chunksBitmapArray: Uint8Array[] | null = null;

  private chunkRecieved = 0;

  constructor(worker: Worker) {
    super();
    this.pc = createPeerConnection();
    this.dataChannel = this.pc.createDataChannel("fileTransfer");
    this.dataChannel.bufferedAmountLowThreshold = 4 * 1024 * 1024;
    this.dataChannel.binaryType = "arraybuffer";

    this.worker = worker;

    worker.addEventListener("message", async (ev : MessageEvent<WorkerResponse>) => {
      const { action, status, result } = ev.data;

      switch (action) {
        case WorkerAction.GetMetadata: {
          if (status === "SUCCESS" && result) {
            this.filesRecordList = result;
            this.initChunksBitmap();

            console.log(result, "flInfo");

            this.emit("fileInfo", {
              files: this.filesRecordList.map(infoLst => {
                return {
                  name: infoLst.fileMetadata.fileInfo.fileName,
                  total: infoLst.fileMetadata.totalChunks,
                  fileSize: infoLst.fileMetadata.fileInfo.fileSize,
                  fileType: infoLst.fileMetadata.fileInfo.fileType,
                  fileId: infoLst.fileMetadata.fileId,
                  ephemeralPublicKey: infoLst.fileMetadata.ephemeralPublicKey,
                  fileHash: infoLst.fileMetadata.rootHash,
                }
              })
            });
          }
          break;
        }
        case WorkerAction.GetEncryptedChunk: {
          if (status === "SUCCESS" && result) {
            const {packet, chunkId, fileId} = result;
            this.currentChunkIndex = chunkId;
            this.currentFileIndex = fileId;
            await this.sendWithBackpressure(packet);
            this.worker.postMessage({ action:  WorkerAction.NextChunkReady});
          }
          break;
        }
        case WorkerAction.SendForRetry: {
          console.log("here transfer completed sneder out");
          if (this.isChunksTransferComplete()) {
            this.setState(TransferState.Completed);
            console.log("here transfer completed sneder");
            // this.emit("complete", void);
            return;
          }
          if (!this.recipientKey) return;
          this.setState(TransferState.Retry);
          const retryPayload: WorkerRequest = {
            action: WorkerAction.Retry,
            payload: {
              recipientKey: this.recipientKey,
              filesRecordList: this.filesRecordList,
              bitmapArray: this.chunksBitmapArray as Uint8Array[],
            },
          };
          worker.postMessage(retryPayload);
          break;
        }
      }
    });

    this.fileHandleList = [];

    this.setState(TransferState.Idel);

    this.dataChannel.onopen = async () => {
      this.setState(TransferState.Handshaking);
    }

    this.dataChannel.onmessage = async (event) => {
      const dataPayload = new Uint8Array(event.data as ArrayBuffer);
      this.onDataMessageRecieve(dataPayload);
    }

    this.speedCalc = new SpeedCalculator();
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
        this.speedCalc.reset();
        this.onTransfer();
        return;
      } case TransferState.Paused: {
        return;
      } case TransferState.Completed: {
        this.sendUntilAck(DataPayloadType.Status, {type: StatusType.Complete, ok: true}, () => this.completeAck);
      }
    }
  }

  static async initConnection(worker: Worker): Promise<Sender> {
    const sender = new Sender(worker);

    await sender.initConnection();
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
    this.pauseState.local.resumeFromFileId = this.currentFileIndex;
    this.pauseState.local.resumeFromChunkId = this.currentChunkIndex;
    this.pauseInfoSend();
    if (isPaused === true) {
      this.setState(TransferState.Paused);
      this.worker.postMessage({action: WorkerAction.Pause});
    }
    else {
      this.worker.postMessage({action: WorkerAction.Resume});
      this.updatePauseState();
    }
  }

  private async initConnection(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.setState(TransferState.Connecting);
  }


  async initFiles(fileList: FileSystemFileHandle[]) {
    if (fileList.length <= 0) {
      throw new Error("No files selected");
    }
    if (!this.localKeys) {
      throw new Error("Sender class not initialized properly, signing keys not generated.");
    }
    this.fileHandleList = fileList;

    const workerFileMetadataPayload: FileMetadataPayload = {
      fileHandleList: this.fileHandleList,
      signingKeyPair: this.localKeys,
    }

    const fileMetadataRequest: WorkerRequest = {
      action: WorkerAction.GetMetadata,
      payload: workerFileMetadataPayload,
    }

    this.worker.postMessage(fileMetadataRequest);
  }

  private onTransfer() {

    if (this.transferState !== TransferState.Transferring) return;
    const transferChunksReq: WorkerRequest = {
      action: WorkerAction.GetEncryptedChunk,
      payload: {
        recipientKey: this.recipientKey as CryptoKey,
        filesRecordList: this.filesRecordList
      }
    }
    this.worker.postMessage(transferChunksReq);
  }

  private async senderSigningKeySend() {
    if (!this.localKeys) throw new Error("local keys pair not set.");
    const keyBuffer = await crypto.subtle.exportKey("spki", this.localKeys.publicKey);
    const senderPub = new Uint8Array(keyBuffer);
    await this.sendUntilAck(DataPayloadType.SenderSigningKey, senderPub, () => this.senderKeyAck);
  }

  private async fileInfoSend() {
    if (!this.filesRecordList || this.filesRecordList.length <= 0) {
      throw new Error("No files info found.");
    }
    const fileInfo = this.filesRecordList.map(fr => fr.fileMetadata);

    await this.sendUntilAck(DataPayloadType.FileInfo, fileInfo, () => this.fileInfoAck);
  }

  private async pauseInfoSend() {
    const pauseInfo = this.pauseState.local;
    this.localPauseAck = false;
    this.emit("pause", {
      by: "local",
      paused: pauseInfo.pause,
    });
    this.sendUntilAck(DataPayloadType.PauseInfo, pauseInfo, () => this.localPauseAck);
  }

  private updatePauseState() {
    if (!this.pauseState.local.pause && !this.pauseState.remote.pause) {
      this.setState(TransferState.Transferring);
    }
  }

  private onRemotePause(remotePauseInfo: PauseStatus) {
    this.pauseState.remote = remotePauseInfo;
    this.currentFileIndex = this.pauseState.remote.resumeFromFileId;
    this.currentChunkIndex = this.pauseState.remote.resumeFromChunkId;
    const packet = encodeDataPayload({type: DataPayloadType.Status, data: {ok: true, type: StatusType.Pause}});
    if (!packet) return;
    this.dataChannel.send(packet.buffer as ArrayBuffer);
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
      case StatusType.SenderSigningKey: {
        this.senderKeyAck = true;
        break;
      } case StatusType.FileInfo: {
        this.fileInfoAck = true;
        break;
      } case StatusType.Pause: {
        this.localPauseAck = true;
        return;
      } case StatusType.Complete: {
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

  private async onRecipientKeyMessage(recipientKey: Uint8Array) {
    this.recipientKey = await importECDHPublicKey(recipientKey);
    const packet = encodeDataPayload({ type: DataPayloadType.Status, data: { ok: true, type: StatusType.RecipientEncryptionKey } });
    if (!packet) return;
    this.dataChannel.send(packet.buffer as ArrayBuffer);
  }

  private async onDataMessageRecieve(dataPayload: Uint8Array) {
    const type = dataPayload[0] as DataPayloadType;
    const data = dataPayload.slice(1);
    switch (type) {
      case DataPayloadType.RecipientEncryptionKey: {
        await this.onRecipientKeyMessage(data);
        this.tryAdvanceHandshake();
        return;
      } case DataPayloadType.PauseInfo: {
        const decodedData = decodePauseStatus(data);
        this.onRemotePause(decodedData);
        return;
      } case DataPayloadType.ChunkAck: {
        this.speedCalc.addSample(CHUNK_SIZE);
        this.emit("speed", {
          bytesPerSecond: this.speedCalc.getCurrentSpeed()
        })
        const decodedData = decodeChunkAck(data);
        this.onChunkAckRecieve(decodedData);
        return;
      } case DataPayloadType.Status: {
        const statusMessage = decodeStatusMessage(data);
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
    this.chunkRecieved++;
    setChunkReceived(this.chunksBitmapArray[fileId], chunkId);

    if (!this.filesRecordList) return;
    const totalChunks = this.filesRecordList.reduce((acc, cur) => acc + cur.fileMetadata.totalChunks, 0);
    const ackProgress = (this.chunkRecieved / totalChunks) * 100;
    this.emit("progress", {
      percent: ackProgress,
      totalChunks: totalChunks,
    });
  }

  private initChunksBitmap() {
    this.chunksBitmapArray = this.filesRecordList?.
                              map(info => createChunkBitmap(info.fileMetadata.totalChunks)) 
                              ?? null;
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

  private async sendWithBackpressure(data: ArrayBuffer) {
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
    // this.isSending = false;

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
    this.filesRecordList = [];

    // 5. Clear crypto
    this.localKeys = null;
    this.recipientKey = null;

    // 6. Dispatch final event
    this.emit("closed", {isClosed: true});
  }
}