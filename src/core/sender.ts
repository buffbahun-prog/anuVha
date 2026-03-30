import { createPeerConnection } from "./webrtc";
import { splitIntoChunks } from "./transfer";
import { selectedFiles } from "./fileManager";
import { setState } from "../state/appState";
import { ViewPage } from "../types";

export async function startSender() {
  const pc = createPeerConnection();
  const channel = pc.createDataChannel("fileTransfer");

  channel.onopen = async () => {
    setState("currentView", ViewPage.FilesTransfer);

    const chunkMatrix: ArrayBuffer[][] = [];

    for (const file of selectedFiles) {
      const buffer = await file.arrayBuffer();
      chunkMatrix.push(splitIntoChunks(buffer));
    }

    console.log("Sender ready with chunks:", chunkMatrix.length);
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) {
      console.log("Send SDP via QR");
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
}