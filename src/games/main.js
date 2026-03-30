import QRCode from 'qrcode';

// ===================== CONFIG =====================
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// ===================== GLOBALS =====================
const canvas = document.getElementById("gameCanvas");
        const ctx = canvas.getContext("2d");
        
        const menuCont = document.getElementById('ui-layer');
        const menu = document.getElementById('menu');
        const menuTitle = document.getElementById('menu-title');
        const menuDesc = document.getElementById('menu-desc');
        const startBtn = document.getElementById('start-btn');
        const topScoreUI = document.getElementById('top-score-ui');
        const bottomScoreUI = document.getElementById('bottom-score-ui');

        let gameState = 'MENU';
        let scores = { top: 0, bottom: 0 };
        let rawTilt = {
          bottom: 0,
          top: 0,
        };
        let calibratedOffset = {
          bottom: 0,
          top: 0,
        };
        let animationFrame;

        const config = {
            paddleWidth: 110,
            paddleHeight: 14,
            ballRadius: 10,
            maxTilt: 25,
            friction: 0.92, // Slightly less friction for better "flick" control
            acceleration: 1.2, // Faster acceleration for "swiping"
            initialBallSpeed: 6,
            speedIncrement: 0.05,
            momentumFactor: 0.35 // How much paddle speed is transferred to the ball
        };

        const ball = {
            x: 0, y: 0, vx: 0, vy: 0, speed: 0,
            reset() {
                this.x = canvas.width / 2 / (window.devicePixelRatio || 1);
                this.y = canvas.height / 2 / (window.devicePixelRatio || 1);
                this.speed = config.initialBallSpeed;
                const angle = (Math.random() * Math.PI / 4) + (Math.random() > 0.5 ? Math.PI / 4 : 5 * Math.PI / 4);
                this.vx = Math.cos(angle) * this.speed;
                this.vy = Math.sin(angle) * this.speed;
            }
        };

        const paddles = {
            bottom: { x: 0, vx: 0, color: '#3b82f6', glow: 'rgba(59, 130, 246, 0.5)' },
            top: { x: 0, vx: 0, color: '#10b981', glow: 'rgba(16, 185, 129, 0.5)' }
        };

        function init() {
          console.log("here");
            resize();
            paddles.bottom.x = window.innerWidth / 2 - config.paddleWidth / 2;
            paddles.top.x = window.innerWidth / 2 - config.paddleWidth / 2;
            ball.reset();
            window.addEventListener('resize', resize);
            startBtn.addEventListener('click', handleStart);
        }

        function resize() {
            const dpr = window.devicePixelRatio || 1;
            canvas.width = window.innerWidth * dpr;
            canvas.height = window.innerHeight * dpr;
            canvas.style.width = window.innerWidth + 'px';
            canvas.style.height = window.innerHeight + 'px';
            ctx.scale(dpr, dpr);
        }

        async function handleStart() {
            // if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            //     try {
            //         const permission = await DeviceOrientationEvent.requestPermission();
            //         if (permission !== 'granted') return;
            //     } catch (e) { console.error(e); }
            // }

            calibratedOffset = {...rawTilt};
            gameState = 'PLAYING';
            menu.classList.add('opacity-0', 'scale-90');
            setTimeout(() => { if(gameState === 'PLAYING') menu.style.display = 'none'; }, 300);
            
            scores = { top: 0, bottom: 0 };
            updateUI();
            ball.reset();
            if(!animationFrame) loop();
        }

        function gameOver(winner) {
            gameState = 'GAMEOVER';
            menu.style.display = 'block';
            menu.classList.remove('opacity-0', 'scale-90');
            menuTitle.innerText = "GAME OVER";
            menuTitle.classList.remove('text-red-500'); // Reset color
            menuDesc.innerHTML = `<span class="text-white text-xl">${winner} Wins!</span><br>Score: ${scores.top} - ${scores.bottom}`;
            startBtn.innerText = "REMATCH";
        }

        // window.addEventListener('deviceorientation', (e) => {
        //     rawTilt = e.gamma || 0;
        // });

        // window.addEventListener('mousemove', (e) => {
        //     if (window.innerWidth > 0) {
        //         const percent = (e.clientX / window.innerWidth) - 0.5;
        //         if (!window.DeviceOrientationEvent || rawTilt === 0) {
        //             rawTilt = percent * 60; 
        //         }
        //     }
        // });

        function updateUI() {
            topScoreUI.innerText = scores.top;
            bottomScoreUI.innerText = scores.bottom;
        }

        function update() {
            if (gameState !== 'PLAYING') return;

            // 1. Paddle Movement
            const currentTilt = {bottom: rawTilt.bottom - calibratedOffset.bottom, top: rawTilt.top - calibratedOffset.top}
            // const currentTilt = rawTilt - calibratedOffset;
            let targetAccel = {
              top: (currentTilt.top / config.maxTilt) * config.acceleration,
              bottom: (currentTilt.bottom / config.maxTilt) * config.acceleration
            };
            targetAccel = {
              top: Math.max(-config.acceleration, Math.min(config.acceleration, targetAccel.top)),
              bottom: Math.max(-config.acceleration, Math.min(config.acceleration, targetAccel.bottom))
            };

            paddles.bottom.vx += targetAccel.bottom;
            paddles.top.vx += targetAccel.top;

            paddles.bottom.vx *= config.friction;
            paddles.top.vx *= config.friction;

            paddles.bottom.x += paddles.bottom.vx;
            paddles.top.x += paddles.top.vx;

            const maxW = window.innerWidth;
            [paddles.bottom, paddles.top].forEach(p => {
                if (p.x < 0) { p.x = 0; p.vx = 0; }
                if (p.x > maxW - config.paddleWidth) { p.x = maxW - config.paddleWidth; p.vx = 0; }
            });

            // 2. Ball Movement
            ball.x += ball.vx;
            ball.y += ball.vy;

            // Horizontal Wall Bounce
            if (ball.x - config.ballRadius < 0 || ball.x + config.ballRadius > maxW) {
                ball.vx *= -1;
                ball.x = ball.x < config.ballRadius ? config.ballRadius : maxW - config.ballRadius;
            }

            // Paddle Collision Logic
            const checkCollision = (paddle, yPos, isTop) => {
                const withinX = ball.x > paddle.x && ball.x < paddle.x + config.paddleWidth;
                const withinY = isTop 
                    ? (ball.vy < 0 && ball.y - config.ballRadius <= yPos + config.paddleHeight && ball.y > yPos)
                    : (ball.vy > 0 && ball.y + config.ballRadius >= yPos && ball.y < yPos + config.paddleHeight);

                if (withinX && withinY) {
                    // Reverse vertical direction
                    ball.vy = isTop ? Math.abs(ball.vy) : -Math.abs(ball.vy);
                    
                    // --- DIRECTION CHANGE LOGIC ---
                    // 1. Position-based influence (classic pong)
                    const distFromCenter = (ball.x - (paddle.x + config.paddleWidth / 2)) / (config.paddleWidth / 2);
                    ball.vx += distFromCenter * 2;

                    // 2. Momentum-based influence (The "Swipe" effect)
                    // We add a portion of the paddle's current velocity to the ball's horizontal velocity
                    ball.vx += paddle.vx * config.momentumFactor;

                    // 3. Speed Boost
                    ball.speed += config.speedIncrement;
                    // Normalize and re-apply speed to maintain game intensity
                    const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
                    ball.vx = (ball.vx / currentSpeed) * ball.speed;
                    ball.vy = (ball.vy / currentSpeed) * ball.speed;
                    
                    // Move ball out of paddle to prevent multi-hit bugs
                    ball.y = isTop ? yPos + config.paddleHeight + config.ballRadius : yPos - config.ballRadius;
                }
            };

            checkCollision(paddles.top, 40, true);
            checkCollision(paddles.bottom, window.innerHeight - 40, false);

            // Score Detection
            if (ball.y < -20) {
                scores.bottom++;
                updateUI();
                if (scores.bottom >= 7) gameOver("Bottom Player");
                else ball.reset();
            } else if (ball.y > window.innerHeight + 20) {
                scores.top++;
                updateUI();
                if (scores.top >= 7) gameOver("Top Player");
                else ball.reset();
            }
        }

        function draw() {
            ctx.fillStyle = "rgba(15, 23, 42, 0.4)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Center Line
            ctx.setLineDash([10, 15]);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, window.innerHeight / 2);
            ctx.lineTo(window.innerWidth, window.innerHeight / 2);
            ctx.stroke();
            ctx.setLineDash([]);

            if (gameState === 'PLAYING' || gameState === 'GAMEOVER') {
                drawPaddle(paddles.top.x, 40, paddles.top.color, paddles.top.glow);
                drawPaddle(paddles.bottom.x, window.innerHeight - 40, paddles.bottom.color, paddles.bottom.glow);

                // Ball with glow
                ctx.shadowBlur = 15;
                ctx.shadowColor = "#fff";
                ctx.fillStyle = "#fff";
                ctx.beginPath();
                ctx.arc(ball.x, ball.y, config.ballRadius, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
            }
        }

        function drawPaddle(x, y, color, glow) {
            ctx.shadowBlur = 20;
            ctx.shadowColor = glow;
            ctx.fillStyle = color;
            const r = 6;
            const w = config.paddleWidth;
            const h = config.paddleHeight;
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, r);
            ctx.fill();
            ctx.shadowBlur = 0;
        }

        function loop() {
            update();
            draw();
            animationFrame = requestAnimationFrame(loop);
        }

// ===================== QR / COMPRESSION =====================
async function compress(data) {
  const json = JSON.stringify(data);
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  writer.write(new TextEncoder().encode(json));
  writer.close();
  const buf = await new Response(stream.readable).arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function decompress(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(stream.readable).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(buf));
}

// ===================== HOST =====================
let pc;
let nextSlabRole = "bottom";
const peers = [];
// ===================== DATA CHANNEL HANDLER =====================
function setupHostDataChannel(channel) {
  const role = nextSlabRole;
  nextSlabRole = role === "bottom" ? "top" : "bottom";

  peers.push({ channel, role });

  channel.onopen = async () => {
    log(`✅ Connected: ${role}`);
    if (!animationFrame) draw();
  };

  channel.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.isO) rawTilt[role] = d.beta;
  };
}

// ===================== CAMERA / QR SCANNER =====================
async function startCamera() {
  const video = document.getElementById("camera");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream;
  await new Promise(res => { video.onloadedmetadata = () => video.play(); video.onplaying = () => res(); });
  return video;
}

async function scanQR(video, onResult) {
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const interval = setInterval(async () => {
    if (video.readyState < 2) return;
    const codes = await detector.detect(video);
    if (codes.length > 0) {
      clearInterval(interval);
      onResult(codes[0].rawValue);
    }
  }, 400);
}

// ===================== HOST SCANNER =====================
let scanning = false;
let videoElement = null;

/**
 * Starts the camera and returns the video element
 */
async function startCameraStream() {
  const video = await startCamera();
  videoElement = video;
  return video;
}

/**
 * Creates a new peer connection and sets up data channel
 */
async function createPeerConnection() {
  const pc = new RTCPeerConnection(rtcConfig);

  const channel = pc.createDataChannel("motion");
  setupHostDataChannel(channel);

  pc.onicecandidate = async (event) => {
    if (!event.candidate) {
      const payload = await compress({ sdp: pc.localDescription });
      showQR(payload);
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
  return pc;
}

/**
 * Scans for peers via QR code
 */
let isInit = false;
async function scanNextPeer(video) {
  if (!scanning) return;

  try {
    const pc = await createPeerConnection();

    await scanQR(video, async (data) => {
      const parsed = await decompress(data);
      await pc.setRemoteDescription(parsed.sdp);
      log("✅ Peer connected");
      if (!isInit) {
        menuCont.classList.remove("hidden");
        canvas.classList.remove("hidden");
        init();
        isInit = true;
      }
    });
  } catch (err) {
    console.error("Error scanning peer:", err);
  }
}

/**
 * Starts the host scanner
 */
export async function startHostScanner() {
  if (scanning) return; // already scanning
  scanning = true;

  const video = await startCameraStream();
  scanNextPeer(video);
}

/**
 * Stops the host scanner
 */
export function stopHostScanner() {
  scanning = false;
  if (videoElement?.srcObject) {
    videoElement.srcObject.getTracks().forEach((track) => track.stop());
  }
  videoElement = null;
}


// ===================== MOBILE =====================
async function startMobile() {
  const video = await startCamera();
  showQR("");

  scanQR(video, async (data) => {
    const parsed = await decompress(data);
    await setupMobile(parsed.sdp, video);
  });
}

async function setupMobile(remoteSDP, video) {
  pc = new RTCPeerConnection(rtcConfig);

  pc.ondatachannel = (event) => {
    const ch = event.channel;

    ch.onopen = () => {
      log("✅ Connected");
      video.srcObject.getTracks().forEach(t => t.stop());
      closeQR();
    };

    window.addEventListener("deviceorientation", (ev) => {
      if (ch.readyState !== "open") return;
      ch.send(JSON.stringify({ alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma, isO: true }));
    });
  };

  await pc.setRemoteDescription(remoteSDP);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  pc.onicecandidate = async (e) => {
    if (!e.candidate) {
      const payload = await compress({ sdp: pc.localDescription });
      showQR(payload);
    }
  };
}

// ===================== HELPERS =====================
function log(msg) {
  document.getElementById("log").textContent = msg;
}
function showQR(data) {
  const pop = document.getElementById("qrPopover");
  QRCode.toCanvas(document.getElementById("qrCanvas"), data);
  pop.showPopover();
}
function closeQR() { const pop = document.getElementById("qrPopover"); if (pop.matches(":popover-open")) pop.hidePopover(); }

// ===================== UI =====================
document.getElementById("startHost").onclick = startHostScanner;
document.getElementById("startMobile").onclick = startMobile;
document.getElementById("endConnection").onclick = () => {
  if (pc) pc.close();
  log("🔴 Connection ended");
};

const popover = document.getElementById("qrPopover");

popover.addEventListener('toggle', (event) => {
  if (event.newState === "closed") {
    stopHostScanner();
  }
  console.log(`Popover is now ${event.newState}`); // "open" or "closed"
});