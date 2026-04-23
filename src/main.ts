// ===================== IMPORTS =====================
//import "./style.css";
import QRCode from "qrcode";
import { BrowserQRCodeReader } from '@zxing/browser';

import {
  formatFileSize,
  getFileCategory,
} from "./utils/convert";

import { UploadAnimation } from "./objects/upload-animation";
import { getNetworkState, NetworkStatus } from "./utils/networkState";
import { ConnectionType, PeerType, TransferState, ViewPage} from "./types";
import { Sender } from "./core/sender";
import { Reciever } from "./core/reciever";

type FileInfo = {
  fileId: number;
  name: string;
  total: number;
  fileSize: number;
  fileType: string;
};

const worker = new Worker(
  new URL("./core/workers/index.worker.ts", import.meta.url),
  {  type: "module"}
)

// ===================== DOM =====================
const videoScanner = document.getElementById("qrVideo") as HTMLVideoElement;
const codeReader = new BrowserQRCodeReader();
const canvas = document.getElementById("qrCanvas") as HTMLCanvasElement;

const uploadProgressElm = document.getElementById("uploadProgress")!;
const fileSizeElm = document.getElementById("fileSize")!;
const uploadRateElm = document.getElementById("uploadRate")!;
const pauseToggleBtn = document.getElementById("pauseToggle") as HTMLButtonElement;

const peerPauseBar = document.getElementById("peerPauseBar") as HTMLDivElement;
const peerPauseTextElm = document.getElementById("peerPauseText") as HTMLDivElement;

const showQR = (data: string) => {
  QRCode.toCanvas(canvas, data, { errorCorrectionLevel: "L" });
};


// ===================== COMMON =====================
function updateUIProgress(progress: number) {
  uploadProgressElm.textContent = `${progress.toFixed(0)}%`;
}

function updateSpeed(bytesPerSec: number) {
  uploadRateElm.textContent = `${formatFileSize(bytesPerSec, 0)}/s`;
}


function applyRemotePause(isPause: boolean, by: "reciever" | "sender") {
  peerPauseBar.classList.toggle("show-peer-pause", isPause);
  peerPauseTextElm.textContent = by === "reciever" ? "Paused by Receiver" : "Paused by Sender";
}

async function initSender() {
  // 1. Initialize sender
  const sender = await Sender.initConnection(worker);

  const anim: UploadAnimation = new UploadAnimation(0, "sender");

  sender.on("stateChange", async (evt) => {
    const state = evt.state;

    switch (state) {
      case TransferState.Handshaking: {
        viewPage = ViewPage.FilesTransfer;
        await updatePageUI();
        anim.mount();
      }
    }
  });

  sender.on("fileInfo", (evt) => {
    const totaChunks = evt.files.reduce((acc, cur) => acc + cur.total, 0);
    const filesTotalSize = evt.files.reduce((acc, cur) => acc + cur.fileSize, 0);
    anim.updateRequestedChunks(totaChunks);
    fileSizeElm.textContent = formatFileSize(filesTotalSize, 2);
    updatePreviewPage(evt.files);
  });

  sender.on("progress", (evt) => {
    const progress = evt.percent;
    updateUIProgress(progress);
    anim.updateProgress(progress);
  });

  sender.on("speed", (evt) => {
    const speed = evt.bytesPerSecond;
    updateSpeed(speed);
  });

  sender.on("pause", (evt) => {
    if (evt.by === "remote") {
      applyRemotePause(evt.paused, "reciever");
    }
  });

  sender.on("closed", (evt) => {
    const isClosed = evt.isClosed;
    if (!isClosed) return;
    anim.cleanup();
  });

  pauseToggleBtn.onclick = () => {
    if (!sender) return; // safety check

    // Toggle pause state
    const nextPause = !sender.getisPaused();

    // Inform sender to pause/resume properly
    sender.onLocalPause(nextPause);

    // Update button UI
    pauseToggleBtn.textContent = nextPause ? "Resume" : "Pause";
    pauseToggleBtn.classList.toggle("paused", nextPause);
  };

  return sender;
}

async function initReceiver() {
  // 1️⃣ Init receiver (protocol + crypto handled internally)
  const receiver = await Reciever.initConnection();

  const anim = new UploadAnimation(0, "receiver");

  let filesInfo: FileInfo[] | null = null;

  receiver.on("stateChange", async (evt) => {
    const state = evt.state;

    switch (state) {
      case TransferState.Handshaking: {
        viewPage = ViewPage.FilesTransfer;
        await updatePageUI();
        anim.mount();
      }
    }
  });

  receiver.on("fileInfo", (evt) => {
    filesInfo = evt.files;
    const totaChunks = evt.files.reduce((acc, cur) => acc + cur.total, 0);
    const filesTotalSize = evt.files.reduce((acc, cur) => acc + cur.fileSize, 0);
    anim.updateRequestedChunks(totaChunks);
    fileSizeElm.textContent = formatFileSize(filesTotalSize, 2);
    updatePreviewPage(evt.files);
  });

  receiver.on("progress", (evt) => {
    const progress = evt.percent;
    updateUIProgress(progress);
    anim.updateProgress(progress);
  });

  receiver.on("speed", (evt) => {
    const speed = evt.bytesPerSecond;
    updateSpeed(speed);
  });

  receiver.on("pause", (evt) => {
    if (evt.by === "remote") {
      applyRemotePause(evt.paused, "sender");
    }
  });

  receiver.on("complete", (evt) => {
    if (filesInfo && evt) setupFinalDownload(filesInfo, evt.opfs);
  });

  receiver.on("closed", (evt) => {
    const isClosed = evt.isClosed;
    if (!isClosed) return;
    anim.cleanup();
  });
  
  // 🔟 Pause button (IMPORTANT: use class API, not local state)
  pauseToggleBtn.onclick = () => {
    const nextPause = !receiver['pauseState'].pause;

    receiver.onLocalPause(nextPause);

    pauseToggleBtn.textContent = nextPause ? "Resume" : "Pause";
    pauseToggleBtn.classList.toggle("paused", nextPause);
  };

  return receiver;
}

async function setupFinalDownload(filesInfo: FileInfo[], opfsRoot: FileSystemDirectoryHandle) {
    downloadBtn.classList.remove("disabled");
    downloadBtn.onclick = async () => {
      const filteredFilesInfo = filesInfo.filter(info => !removeFileIds.includes(info.fileId));
        for (const info of filteredFilesInfo) {
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

function stopCamera() {
  (videoScanner.srcObject as MediaStream)?.getTracks().forEach(t => t.stop());
  videoScanner.srcObject = null;
}

let sender: Sender | null = null;
let reciever: Reciever | null = null;

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
const downloadBtn = document.getElementById("downloadBtn") as HTMLDivElement;
const previewBtn = document.getElementById("previewBtn") as HTMLDivElement;
const previewView = document.getElementById("preview") as HTMLDivElement;
const previewBackBtn = document.getElementById("previewBackBtn") as HTMLDivElement;

async function updatePageUI() {
  stopCamera();

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
      downloadBtn.classList.add("hidden");

      break;
    } case PeerType.Reciever: {
      console.log("rec");
      qrExchangeChooseCont.classList.add("reverse-row");
      if (!isQrScanned) showQrBtn.classList.add("disabled");
      else showQrBtn.classList.remove("disabled");

      break;
    }
  }

  switch (viewPage) {
    case ViewPage.TransferLanding: {
      transferLandingView.classList.remove("hidden");
      localCardFileUploadView.classList.add("hidden");
      qrExchangeView.classList.add("hidden");
      fileTransferView.classList.add("hidden");

      sender = null;
      reciever = null;

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

      if (peerType === PeerType.Sender) {
        if (sender === null) sender = await initSender();
        await sender.initFiles(fileHandles);
      }

      if (peerType === PeerType.Reciever && reciever === null) {
        reciever = await initReceiver();
      }

      if (viewPage === ViewPage.QrExchangeShow) {
        showQrBtn.classList.add("selected");
        showQrView.classList.remove("hidden");

        scanQrBtn.classList.remove("selected");
        scanQrView.classList.add("hidden");

        if (peerType === PeerType.Sender && sender) {
          const offer = await sender.getDescriptorJSON();
          showQR(offer);
        }
        if (peerType === PeerType.Reciever && reciever) {
          const answer = await reciever.getDescriptorJSON();
          showQR(answer);
        }
      } else {
        scanQrBtn.classList.add("selected");
        scanQrView.classList.remove("hidden");

        showQrBtn.classList.remove("selected");
        showQrView.classList.add("hidden");
        
        if (peerType === PeerType.Sender && sender) {
          const answer = await scanQRAndReturn();
          isQrScanned = true;
          await sender.setRemoteDescriptor(answer);
        }
        if (peerType === PeerType.Reciever && reciever) {
          const offer = await scanQRAndReturn();
          isQrScanned = true;
          await reciever.setRemoteDescriptor(offer);
          viewPage = ViewPage.QrExchangeShow;
          updatePageUI();
        }
      }

      break;
    } case ViewPage.FilesTransfer: {
        transferLandingView.classList.add("hidden");
        localCardFileUploadView.classList.add("hidden");
        fileTransferView.classList.remove("hidden");
        qrExchangeView.classList.add("hidden");
        previewView.classList.add("hidden");

        pauseToggleBtn.classList.remove("hidden");
        downloadBtn.classList.add("disabled");
      break;
    }
  }
}

previewBtn.addEventListener("click", () => {
  previewView.classList.remove("hidden");
});

previewBackBtn.addEventListener("click", () => {
  previewView.classList.add("hidden");
});

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
})

sendFileLocalBtn.addEventListener("click", () => {
  peerType = PeerType.Sender;
  viewPage = ViewPage.FilesUpload;
  updatePageUI();
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
  try {
    //@ts-ignore
    const pickerHandles = await window.showOpenFilePicker({
      multiple: true
    });

    fileHandles.push(...pickerHandles);
    
    updateLocalFileView();
  } catch (err) {
    console.error("User cancelled or browser doesn't support API", err);
  }
});

// localFileInputElm.addEventListener("change", (evt) => {
//   const inputTarget = evt.target as HTMLInputElement;
//   const selectedFileList = inputTarget.files;
  
//   if (!selectedFileList || selectedFileList.length === 0) return;

//   updateLocalFileView();

//   // Reset the input but wrap it in a timeout to let the UI breathe
//   setTimeout(() => {
//     inputTarget.value = '';
//   }, 100);
// });

async function removeFile(index: number) {
  fileHandles.splice(index, 1);
  updateLocalFileView();
}

const totalVolSummaryElm = document.getElementById("totalVolSummary")!;
const totalFilesSummaryElm = document.getElementById("totalFilesSummary")!;
const localFileListCont = document.getElementById("localFileList")!;

async function getAllFilesInfo() {
  const filesInfo: {name: string; fileType: string, fileSize: number}[] = [];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const handle of fileHandles) {
    const file = await handle.getFile();
    filesInfo.push({
      name: file.name,
      fileType: file.type,
      fileSize: file.size,
    })
    await delay(0);
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

const previewFileListCont = document.getElementById("previewFileList") as HTMLUListElement;
const previewFilesSummary = document.getElementById("previewFilesSummary") as HTMLDivElement;
const previewVolSummary = document.getElementById("previewVolSummary") as HTMLDivElement;
let removeFileIds: number[] = [];

function updatePreviewPage(filesInfo: FileInfo[]) {
  const totalSize = filesInfo.reduce((acc, cur) => acc + cur.fileSize, 0);
  const totalFiles = filesInfo.length;

  previewVolSummary.innerText = formatFileSize(totalSize);
  previewFilesSummary.innerText = totalFiles.toString();

  previewFileListCont.innerHTML = ``;
  for (const info of filesInfo) {
    const fileName = info.name;
    const fileSize = formatFileSize(info.fileSize, 2);
    const fileType = getFileCategory(undefined, info.fileType);

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
          ${removeFileIds.includes(info.fileId) ? '<img src="dot.svg" width="12px" alt="">' : '<img src="check.svg" width="16px" alt="">'}
        </div>
    `;
    const removeBtn = liElement.querySelector(".file-rmv-btn") as HTMLDivElement;
    removeBtn?.addEventListener("click",(e) => {
      e.stopPropagation();
      if (removeFileIds.includes(info.fileId)) removeFileIds = removeFileIds.filter(id => id !== info.fileId);
      else removeFileIds.push(info.fileId);
      updatePreviewPage(filesInfo);
    });

    previewFileListCont.appendChild(liElement);
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

async function scanQRAndReturn(): Promise<string> {
  return new Promise<string>(async (resolve, reject) => {
    let stopped = false;

    videoScanner.setAttribute("autoplay", "true");
    videoScanner.setAttribute("playsinline", "true"); // iOS fix

    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
    } catch (err) {
      reject(err);
      return;
    }

    videoScanner.srcObject = stream;

    const stopAll = () => {
      if (stopped) return;
      stopped = true;

      if (stream) stream.getTracks().forEach(track => track.stop());
      videoScanner.pause();
      videoScanner.srcObject = null;
    };

    try {
      if ("BarcodeDetector" in window) {

    await videoScanner.play();

    // 🛑 Cleanup
    
        //@ts-ignore
        const detector = new BarcodeDetector({ formats: ["qr_code"] });

        const interval = setInterval(async () => {
          if (stopped) return;
          if (videoScanner.readyState < 2) return;

          try {
            const codes = await detector.detect(videoScanner);
            if (codes.length) {
              clearInterval(interval);
              stopAll();
              resolve(codes[0].rawValue);
            }
          } catch (err) {
            clearInterval(interval);
            stopAll();
            reject(err);
          }
        }, 300);

      } else {
        try {
          const result = await codeReader.decodeOnceFromVideoElement(videoScanner);
          stopAll();
          resolve(result.getText());
        } catch (err) {
          stopAll();
          reject(err);
        }
      }
    } catch (err) {
      stopAll();
      reject(err);
    }
  });
}

const fileTransferView = document.getElementById("localCardFileTransfer") as HTMLDivElement;
const transferCancleBtn = document.getElementById("transferCancleBtn") as HTMLDivElement;

transferCancleBtn.addEventListener("click", () => {
  if (sender) {
    sender.cleanup();
  }
  if (reciever) {
    reciever.cleanup();
  }
  sender = null;
  reciever = null;

  while (fileHandles.length) fileHandles.pop();

  viewPage = ViewPage.TransferLanding;
  peerType = null;
  connectionType = ConnectionType.Local;
  updateHomePage();
  updatePageUI();
});