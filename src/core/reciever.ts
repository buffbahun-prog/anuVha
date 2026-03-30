import { createPeerConnection } from "./webrtc";
import { setState } from "../state/appState";
import { ViewPage } from "../types";

export async function startReceiver() {
  const pc = createPeerConnection();

  pc.ondatachannel = (event) => {
    const channel = event.channel;

    setState("currentView", ViewPage.FilesTransfer);

    channel.onmessage = (msg) => {
      console.log("Received:", msg.data);
    };
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) {
      console.log("Receiver SDP ready");
    }
  };
}