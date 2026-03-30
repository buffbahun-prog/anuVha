// ===================== IMPORTS =====================
//import "./style.css";
import QRCode from "qrcode";
import { compressSync, decompressSync } from "fflate";

import {
  compressEncryptSign,
  decryptVerifyDecompress,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from "./crypto/encryption";

import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8,
  cryptoKeyToBase64,
  formatFileSize,
  getFileCategory,
  getUploadSpeed,
  importECDHPublicKey,
  importECDSAPublicKey,
  uint8ToBase64,
  type Sample
} from "./utils/convert";

import { UploadAnimation } from "./objects/upload-animation";
import { getNetworkState, NetworkStatus } from "./utils/networkState";
import { ConnectionType, PeerType, ViewPage } from "./types";

// ===================== CONFIG =====================
const config: RTCConfiguration = {
  // iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const CHUNK_SIZE = 16 * 1024;

// ===================== STATE =====================
let pc: RTCPeerConnection;
let dataChannel: RTCDataChannel;

// ===================== TYPES =====================
type ChunkPayload = {
  fileId: number;
  index: number;
  ciphertext: string;
  iv: string;
  signature: string;
  ephemeralPublicKey: string;
};

type FileInfo = {
  fileId: number;
  name: string;
  total: number;
  fileSize: number;
  fileType: string;
};

type Status = {
  ok: boolean;
  type: "recipientEncryptionKey" | "senderSigningKey" | "complete" | "fileInfo" | "pause";
};

type PauseStatus = {
  pause: boolean;
  from: "sender" | "reciever";
  resumeFromFileIndex: number;
  resumeFromChunkIndex: number;
};

interface DataPayload {
  data: ChunkPayload | string | FileInfo[] | Status | PauseStatus;
  type:
    | "recipientEncryptionKey"
    | "senderSigningKey"
    | "chunk"
    | "status"
    | "fileInfo"
    | "pauseInfo";
}

// ===================== DOM =====================
const videoScanner = document.getElementById("qrVideo") as HTMLVideoElement;
const canvas = document.getElementById("qrCanvas") as HTMLCanvasElement;

const uploadProgressElm = document.getElementById("uploadProgress")!;
const fileSizeElm = document.getElementById("fileSize")!;
const uploadRateElm = document.getElementById("uploadRate")!;
const pauseToggleBtn = document.getElementById("pauseToggle") as HTMLButtonElement;

const peerPauseBar = document.getElementById("peerPauseBar") as HTMLDivElement;
const peerPauseTextElm = document.getElementById("peerPauseText") as HTMLDivElement;

// ===================== UTIL =====================
const splitBuffer = (buffer: ArrayBuffer) => {
  const chunks: ArrayBuffer[] = [];
  for (let i = 0; i < buffer.byteLength; i += CHUNK_SIZE) {
    chunks.push(buffer.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
};

const compress = (data: any): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return btoa(String.fromCharCode(...compressSync(bytes)));
};

const decompress = (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(decompressSync(bytes)));
};

const showQR = (data: string) => {
  QRCode.toCanvas(canvas, data, { errorCorrectionLevel: "L" });
};

// ===================== CAMERA =====================
async function startCamera() {
  videoScanner.autoplay = true;
  videoScanner.srcObject = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" }
  });
  await videoScanner.play();
  return videoScanner;
}

async function scanQR(video: HTMLVideoElement, onResult: (data: string) => void) {
  //@ts-ignore
  const detector = new BarcodeDetector({ formats: ["qr_code"] });

  const interval = setInterval(async () => {
    if (video.readyState < 2) return;

    const codes = await detector.detect(video);
    if (codes.length) {
      clearInterval(interval);
      onResult(codes[0].rawValue);
    }
  }, 400);
}

// ===================== COMMON =====================
function updateUIProgress(progress: number) {
  uploadProgressElm.textContent = `${progress.toFixed(0)}%`;
}

function updateSpeed(samples: Sample[], bytes: number) {
  samples.push({ time: performance.now(), bytes });
  uploadRateElm.textContent = getUploadSpeed(samples);
}

// ===================== SENDER =====================

async function startSender() {
  pc = new RTCPeerConnection(config);
  dataChannel = pc.createDataChannel("fileTransfer");
  dataChannel.bufferedAmountLowThreshold = 512 * 1024;

  dataChannel.onopen = async () => {
    viewPage = ViewPage.FilesTransfer;
    updatePageUI();

    // Logic for keys and state remains the same
    const senderKeys = await generateSigningKeyPair();
    const senderPub = await cryptoKeyToBase64(senderKeys.publicKey);

    let recipientKey: CryptoKey | null = null;
    let senderAck = false;
    let fileStarted = false;
    const samples: Sample[] = [];

    const senderPause: PauseStatus = { pause: false, from: "sender", resumeFromFileIndex: 0, resumeFromChunkIndex: 0 };
    const receiverPause: PauseStatus = { pause: false, from: "reciever", resumeFromFileIndex: 0, resumeFromChunkIndex: 0 };

    pauseToggleBtn.textContent = "Pause";

    dataChannel.send(JSON.stringify({ type: "senderSigningKey", data: senderPub }));

    const anim = new UploadAnimation(0, "sender");

    async function calculateTotalChunks(handles: FileSystemFileHandle[]) {
      let totalChunks = 0;
      for (const handle of handles) {
        const file = await handle.getFile();
        totalChunks += Math.ceil(file.size / CHUNK_SIZE);
      }
      return totalChunks;
    }

    const files = await getAllFilesInfo();
    const filesTotalSize = files.reduce((acc, cur) => acc + cur.fileSize, 0);

    // We still need a way to track progress, so we pre-calculate total chunks 
    // based on our known chunk size (assuming a constant CHUNK_SIZE used in splitBuffer)
    const CHUNK_SIZE = 16 * 1024; // Example size, adjust to your splitBuffer logic
    const totalChunks = await calculateTotalChunks(fileHandles);

    const sendChunks = async (startFileId: number, startChunkIndex: number) => {
      let globalChunkNo = await calculateTotalChunks(fileHandles.slice(0, startFileId)) + startChunkIndex;

      console.log(fileHandles.length, "ins", files);
      for (let fileId = startFileId; fileId < fileHandles.length; fileId++) {
        const handle = fileHandles[fileId];


        const file = await handle.getFile();
        const stream = file.stream();
        const reader = stream.getReader();
        let currentFileChunkIndex = 0;

        try {
          let buffer = new Uint8Array(0);

          while (true) {
            const { done, value } = await reader.read();
            if (done && buffer.length === 0) break;
          
            if (value) {
              // append incoming chunk
              const temp = new Uint8Array(buffer.length + value.length);
              temp.set(buffer, 0);
              temp.set(value, buffer.length);
              buffer = temp;
            }
          
            // process fixed-size chunks
            while (buffer.length >= CHUNK_SIZE || (done && buffer.length > 0)) {
              const chunk = buffer.slice(0, CHUNK_SIZE);
              buffer = buffer.slice(CHUNK_SIZE);
            
              // ===== YOUR EXISTING LOGIC STARTS HERE =====
            
              if (senderPause.pause) {
                senderPause.resumeFromFileIndex = fileId;
                senderPause.resumeFromChunkIndex = currentFileChunkIndex;
                dataChannel.send(JSON.stringify({ type: "pauseInfo", data: senderPause }));
                return;
              }
            
              if (receiverPause.pause) return;
            
              const payload = await compressEncryptSign(
                senderKeys,
                recipientKey!,
                chunk.buffer
              );
            
              if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
                await new Promise<void>(res => {
                  dataChannel.onbufferedamountlow = () => res();
                });
              }
            
              const chunkData: ChunkPayload = {
                fileId: fileId,
                index: currentFileChunkIndex,
                ciphertext: arrayBufferToBase64(payload.ciphertext),
                ephemeralPublicKey: arrayBufferToBase64(payload.ephemeralPublicKey),
                signature: arrayBufferToBase64(payload.signature),
                iv: uint8ToBase64(payload.iv),
              };
            
              const chunkPayload: DataPayload = {
                type: "chunk",
                data: chunkData,
              };
            
              dataChannel.send(JSON.stringify(chunkPayload));
            
              updateSpeed(samples, payload.ciphertext.byteLength);
            
              const progress = ((globalChunkNo + 1) / totalChunks) * 100;
              updateUIProgress(progress);
              anim.updateProgress(progress);
            
              globalChunkNo++;
              currentFileChunkIndex++;
            
              console.log(globalChunkNo);
              await new Promise(r => setTimeout(r, 0));
            }
          
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
        
        // Reset startChunkIndex for subsequent files in the loop
        startChunkIndex = 0;
      }
    };

    dataChannel.onmessage = async (event) => {
      const msg = JSON.parse(event.data) as DataPayload;
      fileSizeElm.textContent = formatFileSize(filesTotalSize, 2);

      if (msg.type === "recipientEncryptionKey") {
        recipientKey = await importECDHPublicKey(msg.data as string);
        dataChannel.send(JSON.stringify({ type: "status", data: { ok: true, type: "recipientEncryptionKey" } }));
        dataChannel.send(JSON.stringify({ type: "senderSigningKey", data: senderPub }));
      }

      if (msg.type === "status") {
        const { ok, type } = msg.data as Status;
        if (type === "senderSigningKey" && ok) senderAck = true;
        if (type === "complete" && ok) pc.close();
      }

      if (!fileStarted && senderAck && recipientKey) {
        fileStarted = true;
        anim.updateRequestedChunks(totalChunks);
        console.log("here");

        const fileInfo: FileInfo[] = files.map((file, i) => ({
          fileId: i,
          name: file.name,
          fileSize: file.fileSize,
          fileType: file.fileType,
          total: Math.ceil(file.fileSize / CHUNK_SIZE),
        }));

        dataChannel.send(JSON.stringify({ type: "fileInfo", data: fileInfo }));
        sendChunks(0, 0);
      }

      if (msg.type === "pauseInfo") {
        const { pause, resumeFromFileIndex, resumeFromChunkIndex } = msg.data as PauseStatus;
        receiverPause.pause = pause;
        senderPause.resumeFromFileIndex = resumeFromFileIndex;
        senderPause.resumeFromChunkIndex = resumeFromChunkIndex;

        pause ? peerPauseBar.classList.add("show-peer-pause") : peerPauseBar.classList.remove("show-peer-pause");
        peerPauseTextElm.textContent = "Paused by Reciever";

        if (!pause) sendChunks(senderPause.resumeFromFileIndex, senderPause.resumeFromChunkIndex);
      }
    };

    pauseToggleBtn.onclick = () => {
      senderPause.pause = !senderPause.pause;
      pauseToggleBtn.textContent = senderPause.pause ? "Resume" : "Pause";
      senderPause.pause ? pauseToggleBtn.classList.add("paused") : pauseToggleBtn.classList.remove("paused");
      dataChannel.send(JSON.stringify({ type: "pauseInfo", data: senderPause }));

      if (!senderPause.pause) {
        sendChunks(senderPause.resumeFromFileIndex, senderPause.resumeFromChunkIndex);
      }
    };
  };

  pc.onicecandidate = async (e) => {
    console.log("here", e.candidate);
    if (!e.candidate) showQR(compress({ sdp: pc.localDescription }));
  };

  await pc.setLocalDescription(await pc.createOffer());
}

// ===================== RECEIVER =====================

async function startReceiver() {
  pc = new RTCPeerConnection(config);

  pc.ondatachannel = async (event) => {
    viewPage = ViewPage.FilesTransfer;
    updatePageUI();

    const channel = event.channel;
    const anim = new UploadAnimation(0, "receiver");

    // 1. Get access to the private disk storage
    const opfsRoot = await navigator.storage.getDirectory();

    const keyPair = await generateEncryptionKeyPair();
    const pubKey = await cryptoKeyToBase64(keyPair.publicKey);

    console.log("here");

    channel.send(JSON.stringify({
      type: "recipientEncryptionKey",
      data: pubKey
    }));

    let senderKey: CryptoKey | null = null;
    let filesInfo: FileInfo[] = [];
    
    // Replace ArrayBuffer[][] with FileSystemWritableFileStream[]
    let fileWriters: FileSystemWritableFileStream[] = [];
    
    let expected = 0;
    let receivedIndex: { fileId: number; index: number }[] = [];
    const samples: Sample[] = [];

    const pauseState: PauseStatus = {
      pause: false,
      from: "reciever",
      resumeFromFileIndex: 0,
      resumeFromChunkIndex: 0,
    };

    pauseToggleBtn.textContent = pauseState.pause ? "Resume" : "Pause";
    pauseToggleBtn.onclick = () => {
      pauseState.pause = !pauseState.pause;
      pauseToggleBtn.textContent = pauseState.pause ? "Resume" : "Pause";
      pauseState.pause ? pauseToggleBtn.classList.add("paused") : pauseToggleBtn.classList.remove("paused");

      const pausePayload: DataPayload = {
        type: "pauseInfo",
        data: pauseState,
      }
      channel.send(JSON.stringify(pausePayload));
    };

    channel.onmessage = async (event) => {
      const msg = JSON.parse(event.data) as DataPayload;

      if (msg.type === "senderSigningKey") {
        console.log("senderKey" ,msg);
        senderKey = await importECDSAPublicKey(msg.data as string);
        channel.send(JSON.stringify({ type: "status", data: { ok: true, type: "senderSigningKey" } }));
        channel.send(JSON.stringify({ type: "recipientEncryptionKey", data: pubKey }));
      }

      if (msg.type === "fileInfo") {
        console.log("fileInfo", filesInfo);
        const infoList = msg.data as FileInfo[];
        filesInfo = infoList;
        expected = filesInfo.reduce((acc, cur) => acc + cur.total, 0);
        const totalFilesSize = filesInfo.reduce((acc, cur) => acc + cur.fileSize, 0);

        // 2. Prepare the Disk Writers for each file
        for (const info of filesInfo) {
          console.log("fileInfo", info);
          // const div = document.createElement("div");
          // div.addEventListener("click", async () => {
            const fileHandle = await opfsRoot.getFileHandle(info.name, { create: true })
            fileWriters[info.fileId] = await fileHandle.createWritable();
          // });
          // div.click();
        }

        anim.updateRequestedChunks(expected);
        fileSizeElm.textContent = formatFileSize(totalFilesSize, 2);
      }

      if (msg.type === "chunk" && senderKey && !pauseState.pause) {
        const chunk = msg.data as ChunkPayload;
        console.log("ch", chunk);

        const decrypted = await decryptVerifyDecompress(
          senderKey,
          keyPair,
          {
            ciphertext: base64ToArrayBuffer(chunk.ciphertext),
            iv: base64ToUint8(chunk.iv),
            signature: base64ToArrayBuffer(chunk.signature),
            ephemeralPublicKey: base64ToArrayBuffer(chunk.ephemeralPublicKey)
          }
        );

        // 3. Write to disk at the calculated offset
        // We assume a consistent chunk size here (e.g., 16KB). 
        // If your sender varies sizes, you'd need the byte offset sent in the payload.
        const CHUNK_SIZE = 16384; // Adjust to match your splitBuffer size
        const offset = chunk.index * CHUNK_SIZE;

        await fileWriters[chunk.fileId].write({
          type: "write",
          position: offset,
          data: decrypted.buffer as ArrayBuffer // Cast to satisfy TS
        });

        if (!receivedIndex.find(ri => ri.fileId === chunk.fileId && ri.index === chunk.index)) {
          receivedIndex.push({ fileId: chunk.fileId, index: chunk.index });
        }
        
        const received = receivedIndex.length;
        const fileInfo = filesInfo[chunk.fileId];

        // Update pause indices
        if (chunk.index + 1 >= fileInfo.total) {
          pauseState.resumeFromFileIndex = chunk.fileId + 1;
          pauseState.resumeFromChunkIndex = 0;
        } else {
          pauseState.resumeFromFileIndex = chunk.fileId;
          pauseState.resumeFromChunkIndex = chunk.index + 1;
        }

        const progress = (received / expected) * 100;
        updateUIProgress(progress);
        anim.updateProgress(progress);
        updateSpeed(samples, received);

        if (received === expected) {
          pauseToggleBtn.classList.add("hidden");
          downloadBtn.classList.remove("hidden");

          // 4. Close all writers to ensure data is flushed to the OS
          for (const writer of fileWriters) {
            await writer.close();
          }

          setupFinalDownload(filesInfo, opfsRoot);

          channel.send(JSON.stringify({
            type: "status",
            data: { ok: true, type: "complete" }
          }));

          pc.close();
        }
      }

      if (msg.type === "pauseInfo") {
        const { pause } = msg.data as PauseStatus;
        pause ? peerPauseBar.classList.add("show-peer-pause") : peerPauseBar.classList.remove("show-peer-pause");
        peerPauseTextElm.textContent = "Paused by Sender";
      }
    };
  };
  pc.onicecandidate = async (e) => {
    if (!e.candidate) {
      showQR(compress({ sdp: pc.localDescription }));
    }
  };
}


async function setupFinalDownload(filesInfo: FileInfo[], opfsRoot: FileSystemDirectoryHandle) {
    downloadBtn.onclick = async () => {
        for (const info of filesInfo) {
            const fileHandle = await opfsRoot.getFileHandle(info.name);
            const file = await fileHandle.getFile();
            
            // Trigger the browser's native "Save As" or download behavior
            const a = document.createElement("a");
            a.href = URL.createObjectURL(file);
            a.download = info.name;
            a.click();
        }
    };
}

function clearScan() {
  (videoScanner.srcObject as MediaStream)?.getTracks().forEach(t => t.stop());
  videoScanner.srcObject = null;
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

function stopCamera() {
  (videoScanner.srcObject as MediaStream)?.getTracks().forEach(t => t.stop());
  videoScanner.srcObject = null;
}

let networkStatus: NetworkStatus | null = null;
let connectionType: ConnectionType = ConnectionType.Local;
let peerType: PeerType | null = null;
let viewPage: ViewPage = ViewPage.TransferLanding;

const localConnectionBtn = document.getElementById("localType") as HTMLDivElement;
const globalConnectionBtn = document.getElementById("globalType") as HTMLDivElement;
const localInitialView = document.getElementById("local") as HTMLDivElement;
const globalInitialView = document.getElementById("global") as HTMLDivElement;
const qrExchangeView = document.getElementById("qrExchangeCard") as HTMLDivElement;
const qrExchangeChooseCont = document.getElementById("qrExchangeChoose") as HTMLDivElement;
const downloadBtn = document.getElementById("download") as HTMLDivElement;

function updatePageUI() {
  stopCamera();
  switch (viewPage) {
    case ViewPage.TransferLanding: {
      transferLandingView.classList.remove("hidden");
      localCardFileUploadView.classList.add("hidden");
      qrExchangeView.classList.add("hidden");
      fileTransferView.classList.add("hidden");

      break;
    } case ViewPage.FilesUpload: {
      transferLandingView.classList.add("hidden");
      localCardFileUploadView.classList.remove("hidden");
      qrExchangeView.classList.add("hidden");
      fileTransferView.classList.add("hidden");

      break;
    } case ViewPage.QrExchangeShow:
      case ViewPage.QrExchangeScan: {
      transferLandingView.classList.add("hidden");
      localCardFileUploadView.classList.add("hidden");
      fileTransferView.classList.add("hidden");
      qrExchangeView.classList.remove("hidden");

      if (viewPage === ViewPage.QrExchangeShow) {
        showQrBtn.classList.add("selected");
        showQrView.classList.remove("hidden");

        scanQrBtn.classList.remove("selected");
        scanQrView.classList.add("hidden");
      } else {
        scanQrBtn.classList.add("selected");
        scanQrView.classList.remove("hidden");

        showQrBtn.classList.remove("selected");
        showQrView.classList.add("hidden");

        startScan();
      }

      break;
    } case ViewPage.FilesTransfer: {
        transferLandingView.classList.add("hidden");
        localCardFileUploadView.classList.add("hidden");
        fileTransferView.classList.remove("hidden");
        qrExchangeView.classList.add("hidden");

        pauseToggleBtn.classList.remove("hidden");
        downloadBtn.classList.add("hidden");
      break;
    }
  }

  switch (connectionType) {
    case ConnectionType.Local: {
      localConnectionBtn.classList.add("selected");
      localInitialView.classList.remove("hidden");

      globalConnectionBtn.classList.remove("selected");
      globalInitialView.classList.add("hidden");

      break;
    }
    case ConnectionType.Global: {
      globalConnectionBtn.classList.add("selected");
      globalInitialView.classList.remove("hidden");

      localConnectionBtn.classList.remove("selected");
      localInitialView.classList.add("hidden");

      break;
    }
  }

  switch (peerType) {
    case PeerType.Sender: {
      qrExchangeChooseCont.classList.remove("reverse-row");
      showQrBtn.classList.remove("disabled");

      break;
    } case PeerType.Reciever: {
      qrExchangeChooseCont.classList.add("reverse-row");
      if (!isQrScanned) showQrBtn.classList.add("disabled");
      else showQrBtn.classList.remove("disabled");

      break;
    }
  }
}

localConnectionBtn.addEventListener("click", () => {
  if (connectionType === ConnectionType.Local) return;
  connectionType = ConnectionType.Local;
  updatePageUI();
})

globalConnectionBtn.addEventListener("click", () => {
  if (networkStatus !== NetworkStatus.ONLINE) return;
  if (connectionType === ConnectionType.Global) return;
  connectionType = ConnectionType.Global;
  updatePageUI();
})

async function updateHomePage() {
  const stateInfoElm = document.querySelector(".state-info") as HTMLElement;
  stateInfoElm.textContent = "";
  stateInfoElm.classList.add("info-status-dot");
  const state = await getNetworkState();
  let statetext = '';
  switch (state) {
    case NetworkStatus.NO_NETWORK:
      statetext = "No network detected";
      globalConnectionBtn.classList.add("disabled");
      break;
    case NetworkStatus.OFFLINE_LOCAL:
      statetext = "Local network detected";
      globalConnectionBtn.classList.add("disabled");
      break;
    case NetworkStatus.ONLINE:
      statetext = "Internet available";
      globalConnectionBtn.classList.remove("disabled");
      break;
  }
  networkStatus = state;
  stateInfoElm.classList.remove("info-status-dot");
  stateInfoElm.textContent = statetext;
}

window.addEventListener("load", () => {
  updateHomePage();
  updatePageUI();
});

window.addEventListener("online", () => updateHomePage());
window.addEventListener("offline", () => updateHomePage());

const transferLandingView = document.getElementById("transferLanding") as HTMLDivElement;
const localCardFileUploadView = document.getElementById("localCardFileUpload") as HTMLDivElement;
const sendFileLocalBtn = document.getElementById("sendFileLocal") as HTMLLIElement;
const recieveFileLocalBtn = document.getElementById("recieveFileLocal") as HTMLLIElement;
const localFileUploadBackBtn = document.getElementById("localFileUploadBackBtn") as HTMLDivElement;

recieveFileLocalBtn.addEventListener('click', () => {
  peerType = PeerType.Reciever;
  viewPage = ViewPage.QrExchangeScan;
  updatePageUI();
  startReceiver();
})

sendFileLocalBtn.addEventListener("click", () => {
  peerType = PeerType.Sender;
  viewPage = ViewPage.FilesUpload;
  updatePageUI();
  startSender();
});

localFileUploadBackBtn.addEventListener("click", () => {
  peerType = null;
  viewPage = ViewPage.TransferLanding;
  updatePageUI();
});

const localFileInputElm = document.getElementById("localFileInput") as HTMLInputElement;
const localFileUploadBtn = document.getElementById("localFileDrpzn") as HTMLDivElement;
// const files: File[] = [];

// Global state: only store handles, not File objects!
let fileHandles: FileSystemFileHandle[] = [];
localFileUploadBtn.addEventListener("click", async () => {
  // localFileInputElm.click();
  try {
    // 1. Open the native OS picker
    //@ts-ignore
    const pickerHandles = await window.showOpenFilePicker({
      multiple: true
    });

    // 2. Add to our persistent list
    fileHandles.push(...pickerHandles);
    
    updateLocalFileView();
  } catch (err) {
    console.error("User cancelled or browser doesn't support API", err);
  }
});

localFileInputElm.addEventListener("change", (evt) => {
  const inputTarget = evt.target as HTMLInputElement;
  const selectedFileList = inputTarget.files;
  
  if (!selectedFileList || selectedFileList.length === 0) return;

  // Instead of spreading (...), append individually to avoid temporary array creation
  // for (let i = 0; i < selectedFileList.length; i++) {
  //   files.push(selectedFileList[i]);
  // }

  updateLocalFileView();

  // Reset the input but wrap it in a timeout to let the UI breathe
  setTimeout(() => {
    inputTarget.value = '';
  }, 100);
});

async function removeFile(index: number) {
  fileHandles.splice(index, 1);
  updateLocalFileView();
}

const totalVolSummaryElm = document.getElementById("totalVolSummary")!;
const totalFilesSummaryElm = document.getElementById("totalFilesSummary")!;
const localFileListCont = document.getElementById("localFileList")!;

async function getAllFilesInfo() {
  const filesInfo: {name: string; fileType: string, fileSize: number}[] = [];

  for (const handle of fileHandles) {
    const file = await handle.getFile();
    filesInfo.push({
      name: file.name,
      fileType: file.type,
      fileSize: file.size,
    })
  }

  return filesInfo;
}

async function updateLocalFileView() {
  if (fileHandles.length > 0) {
    const allFiles = await getAllFilesInfo();
    const totalSize = allFiles.reduce((acc, cur) => acc + cur.fileSize, 0);
    const totalFiles = fileHandles.length;

    totalVolSummaryElm.textContent = formatFileSize(totalSize, 2);
    totalFilesSummaryElm.textContent = `${totalFiles}`;

    localFileListCont.innerHTML = ``;
    localCardFileUploadView.classList.add("has-file");
    for (const [index, file] of allFiles.entries()) {
      const fileName = file.name;
      const fileSize = formatFileSize(file.fileSize, 2);
      const fileType = getFileCategory(undefined,file.fileType);

      const liElement = document.createElement("li");

      liElement.innerHTML = `
          <div>
            <div>
              <img src="file.svg" alt="">
            </div>
            <div>
              <span>${fileName}</span>
              <span><span>${fileSize}</span> <img src="dot.svg" alt=""> <span>${fileType}</span></span>
            </div>
          </div>
          <div class="file-rmv-btn">
            <img src="cross.svg" alt="">
          </div>
      `;
      const removeBtn = liElement.querySelector(".file-rmv-btn") as HTMLDivElement;
      removeBtn?.addEventListener("click",(e) => {
        e.stopPropagation();
        removeFile(index);
      });

      localFileListCont.appendChild(liElement);
    }
    localFileListCont.scrollTop = localFileListCont.scrollHeight;
  } else {
    localCardFileUploadView.classList.remove("has-file");
    localFileListCont.innerHTML = ``;
  }
}

const localFileUploadNextBtn = document.getElementById("localFileUploadNextBtn") as HTMLDivElement;

localFileUploadNextBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (fileHandles.length <= 0) return;
  viewPage = ViewPage.QrExchangeShow;
  updatePageUI();
});

const qrExchangeBackBtn = document.getElementById("qrExchangeBackBtn") as HTMLDivElement;
const showQrBtn = document.getElementById("showQr") as HTMLDivElement;
const scanQrBtn = document.getElementById("scanQr") as HTMLDivElement;
const showQrView = document.getElementById("showQrCard") as HTMLDivElement;
const scanQrView = document.getElementById("scanQrCard") as HTMLDivElement;

qrExchangeBackBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (peerType === PeerType.Sender) viewPage = ViewPage.FilesUpload;
  else {
    peerType = null;
    viewPage = ViewPage.TransferLanding;
  }
  updatePageUI();
});

let isQrScanned = false;

showQrBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (viewPage === ViewPage.QrExchangeShow) return;
  if (peerType === PeerType.Reciever && !isQrScanned) return;
  viewPage = ViewPage.QrExchangeShow;
  updatePageUI();
});

scanQrBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (viewPage === ViewPage.QrExchangeScan) return;
  viewPage = ViewPage.QrExchangeScan;
  updatePageUI();
});

async function startScan() {
  const video = await startCamera();

  scanQR(video, async (data) => {
    console.log("here");
    await pc.setRemoteDescription(decompress(data).sdp);
    console.log("here too");
    isQrScanned = true;
    if (peerType === PeerType.Reciever) {
      viewPage = ViewPage.QrExchangeShow;
      await pc.setLocalDescription(await pc.createAnswer());
      updatePageUI();
    }
  });
}

const fileTransferView = document.getElementById("localCardFileTransfer") as HTMLDivElement;