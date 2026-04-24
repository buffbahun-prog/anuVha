# ANUVHA: The Bridge Between Our Devices
### *Solving the "Three-Foot" Data Gap*

## The Idea Origin
It started with a simple, recurring annoyance. My wife and I would capture a memory—a high-res photo or a 4K video—on our phones. But the moment I wanted to move that media to my laptop for a quick edit or even between our phones, the "seamless" digital world felt broken.

We were stuck in a loop of installing clunky apps like ShareIt, or worse, the **"Cloud-Hop"**: uploading a massive file to Google Drive just to download it on a machine sitting three feet away. It was slow, OS-dependent, and felt fundamentally inefficient. I realized we didn’t need a middleman or a server; we just needed a way for our devices to talk to each other directly.

---
## The "QR-to-Transfer" Workflow
## System in Action
| (Sender) | (Receiver) |
| :--- | :--- |
| ![Sender Workflow](https://github.com/buffbahun-prog/anuVha/blob/main/public/sender-flow.gif) | ![Receiver Workflow](https://github.com/buffbahun-prog/anuVha/blob/main/public/reciever-flow.gif) |
---

## The Engineering Journey
I set out to build a "Web-Native" bridge—an application that didn't care if you were on Android, iOS, Linux, or Windows. If it has a browser, it has a connection.

### 1. High-Speed Streaming
WebRTC provided the P2P foundation, but large files posed a memory challenge. I integrated the **Streams API** to "chunk" the data, turning a heavy 4K video into a steady, manageable flow. By processing data as **ArrayBuffers** and **Uint8Arrays**, I gained the low-level memory management needed for high-performance transfers.

### 2. The Physical Handshake
One of the biggest hurdles was the "handshake"—the exchange of ICE candidates. I repurposed a **QR/Barcode web component** I had built previously to act as the signaling mechanism. Now, connecting two devices is as simple as a visual handshake: one device shows a QR code, and the other scans it.

### 3. Security & Efficiency
Even though I intended this for local use, I wanted the architecture to be bulletproof. 
* **Asymmetric Encryption:** I implemented the **WebCrypto API** for end-to-end encryption and hashing. It wasn't strictly "necessary," but it was a deep dive into cryptography that ensured our personal media remained private.
* **Mechanical Sympathy:** To keep the receiver's machine responsive, I used **OPFS (Origin Private File System)**. This allows the app to write data directly to the disk as it arrives, which is significantly more memory-friendly and faster than keeping it in RAM.

---

## Current State & Roadmap
ANUVHA is currently a high-performance engine in a functional draft chassis. It is built on the principle of "Mechanical Sympathy"—using the right browser primitives to achieve performance that rivals native applications.

* **Persistence:** I am integrating **IndexedDB** to manage transfer states and handshaking, ensuring the app handles interruptions gracefully.
* **PWA Evolution:** My final step is a full **Progressive Web App** implementation to provide a professional, "installable" feel across all devices.

> **ANUVHA** is about removing the friction between the moments we capture and the tools we use to refine them.
