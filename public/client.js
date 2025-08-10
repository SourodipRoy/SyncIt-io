const $ = (id) => document.getElementById(id);

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
let clientId = null;
let roomId = null;
let isHost = false;
let hostId = null;

let pc = null;                // For listener: single RTCPeerConnection receiving from host
const peers = new Map();      // For host: peerId -> { pc }
let stream = null;            // Host stream from <audio>.captureStream()

// UI elements
const me = $("me");
const roomLabel = $("roomLabel");
const hostLabel = $("hostLabel");
const clientsLabel = $("clients");
const rttLabel = $("rtt");
const hostPanel = $("hostPanel");
const fileInput = $("fileInput");
const audioEl = $("audio");
const playBtn = $("playBtn");
const pauseBtn = $("pauseBtn");
const stopBtn = $("stopBtn");
const seek = $("seek");
const curTime = $("curTime");
const dur = $("dur");
const volume = $("volume");
const muteBtn = $("muteBtn");
const transferSelect = $("transferSelect");
const transferBtn = $("transferBtn");
const kickSelect = $("kickSelect");
const kickBtn = $("kickBtn");
const remoteAudio = $("remoteAudio");
const localVol = $("localVol");
const localMute = $("localMute");
const chatBox = $("chatBox");
const chatInput = $("chatInput");
const chatSend = $("chatSend");

function logChat(line) {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.textContent = line;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Presence UI
function updatePresence(list, host) {
  hostLabel.textContent = host ? host.slice(0, 8) : "—";
  clientsLabel.textContent = (list || []).map(id => id.slice(0, 6)).join(", ") || "—";
  // update selects, exclude self
  transferSelect.innerHTML = "";
  kickSelect.innerHTML = "";
  (list || []).forEach(id => {
    if (id !== clientId) {
      const opt1 = document.createElement("option");
      opt1.value = id; opt1.text = id.slice(0, 8);
      transferSelect.appendChild(opt1);
      const opt2 = document.createElement("option");
      opt2.value = id; opt2.text = id.slice(0, 8);
      kickSelect.appendChild(opt2);
    }
  });
}

// Host: prepare capture + create sender PC per peer
async function ensureHostStream() {
  if (stream) return stream;
  // Use <audio>.captureStream() to grab decoded audio
  // This is supported on modern Chromium/Firefox. Safari 17+ generally OK.
  if (!audioEl.captureStream) {
    alert("Your browser does not support captureStream on <audio>. Try latest Chrome/Firefox.");
    throw new Error("captureStream unsupported");
  }
  stream = audioEl.captureStream();
  return stream;
}

async function hostCreateSenderFor(peerId) {
  await ensureHostStream();
  const pcHost = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

  // Add all tracks to this connection
  stream.getAudioTracks().forEach(tr => pcHost.addTrack(tr, stream));

  pcHost.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: peerId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };

  peers.set(peerId, { pc: pcHost });

  const offer = await pcHost.createOffer({ offerToReceiveAudio: false });
  await pcHost.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "webrtc:signal", targetId: peerId, payload: { kind: "offer", sdp: offer } }));
}

async function hostAttachAll(peerIds) {
  for (const pid of peerIds) {
    try { await hostCreateSenderFor(pid); } catch (e) { console.error(e); }
  }
}

// Listener: single PC to receive from host
async function ensureListenerPC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

  pc.ontrack = (e) => {
    // e.streams[0] should have the host audio
    remoteAudio.srcObject = e.streams[0];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: hostId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };

  return pc;
}

async function listenerHandleOffer(fromId, sdp) {
  hostId = fromId; // sender is host
  const pc = await ensureListenerPC();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: "webrtc:signal", targetId: fromId, payload: { kind: "answer", sdp: answer } }));
}

// Host control bindings
fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  audioEl.src = url;
  await audioEl.load();
  // Initialize capture early so new peers immediately get the stream
  await ensureHostStream();
};

playBtn.onclick = async () => {
  await audioEl.play();
  ws.send(JSON.stringify({ type: "control:playpause", state: "play" }));
};
pauseBtn.onclick = () => {
  audioEl.pause();
  ws.send(JSON.stringify({ type: "control:playpause", state: "pause" }));
};
stopBtn.onclick = () => {
  audioEl.pause();
  audioEl.currentTime = 0;
  ws.send(JSON.stringify({ type: "control:seek", time: 0 }));
  ws.send(JSON.stringify({ type: "control:playpause", state: "pause" }));
};

volume.oninput = () => {
  audioEl.volume = Number(volume.value);
  ws.send(JSON.stringify({ type: "control:volume", volume: Number(volume.value) }));
};
muteBtn.onclick = () => {
  audioEl.muted = !audioEl.muted;
  ws.send(JSON.stringify({ type: "control:mute", muted: audioEl.muted }));
};

seek.oninput = () => {
  if (!audioEl.duration || !isHost) return;
  const t = (Number(seek.value) / 100) * audioEl.duration;
  audioEl.currentTime = t;
  ws.send(JSON.stringify({ type: "control:seek", time: t }));
};

audioEl.addEventListener("timeupdate", () => {
  if (audioEl.duration) {
    dur.textContent = fmtTime(audioEl.duration);
    curTime.textContent = fmtTime(audioEl.currentTime);
    seek.value = String((audioEl.currentTime / audioEl.duration) * 100);
  } else {
    seek.value = "0";
  }
});

// Listener local controls
localVol.oninput = () => {
  remoteAudio.volume = Number(localVol.value);
};
localMute.onclick = () => {
  remoteAudio.muted = !remoteAudio.muted;
};

// Room create/join
$("createBtn").onclick = () => {
  ws.send(JSON.stringify({ type: "room:create", roomId: $("roomId").value, pin: $("pin").value || null }));
};
$("joinBtn").onclick = () => {
  ws.send(JSON.stringify({ type: "room:join", roomId: $("roomId").value, pin: $("pin").value || null }));
};

transferBtn.onclick = () => {
  const targetId = transferSelect.value;
  if (targetId) ws.send(JSON.stringify({ type: "host:transfer", targetId }));
};
kickBtn.onclick = () => {
  const targetId = kickSelect.value;
  if (targetId) ws.send(JSON.stringify({ type: "room:kick", targetId }));
};

// Chat
chatSend.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: "chat:send", text }));
  chatInput.value = "";
};

ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "hello") {
    clientId = msg.clientId;
    me.textContent = `You: ${clientId.slice(0, 8)}`;
    pingLoop();
  }
  else if (msg.type === "error") {
    alert(msg.message);
  }
  else if (msg.type === "room:created") {
    roomId = msg.roomId; isHost = true;
    roomLabel.textContent = roomId;
    hostPanel.classList.remove("hidden");
    logChat(`Created room ${roomId}. You are host.`);
  }
  else if (msg.type === "room:joined") {
    roomId = msg.roomId; isHost = msg.host === true;
    hostId = msg.hostId || null;
    roomLabel.textContent = roomId;
    updatePresence(msg.clients, msg.hostId);
    if (isHost) {
      hostPanel.classList.remove("hidden");
      logChat(`Joined ${roomId} as HOST.`);
    } else {
      hostPanel.classList.add("hidden");
      logChat(`Joined ${roomId} as listener.`);
    }
  }
  else if (msg.type === "presence:update") {
    updatePresence(msg.clients, msg.hostId);
    hostId = msg.hostId;
  }
  else if (msg.type === "webrtc:new-peer") {
    if (!isHost) return;
    hostCreateSenderFor(msg.peerId);
  }
  else if (msg.type === "webrtc:signal") {
    const { fromId, payload } = msg;
    if (payload.kind === "offer") {
      // Listener got offer from host
      await listenerHandleOffer(fromId, payload.sdp);
    } else if (payload.kind === "answer") {
      // Host got answer from peer
      const p = peers.get(fromId);
      if (p) await p.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    } else if (payload.kind === "ice") {
      if (isHost) {
        const p = peers.get(fromId);
        if (p) await p.pc.addIceCandidate(payload.candidate);
      } else {
        if (!pc) await ensureListenerPC();
        await pc.addIceCandidate(payload.candidate);
      }
    }
  }
  else if (msg.type === "control:playpause") {
    if (!isHost && remoteAudio.srcObject) {
      if (msg.state === "play") remoteAudio.play().catch(()=>{});
      if (msg.state === "pause") remoteAudio.pause();
    }
  }
  else if (msg.type === "control:seek") {
    // Note: seeking a live incoming stream isn't meaningful. This message is for cases
    // where host restarts/realigns content. We gently restart playback.
    if (!isHost && remoteAudio.srcObject) {
      // Nothing to seek on remote stream; best effort is to briefly pause/play to re-sync
      remoteAudio.pause();
      setTimeout(() => remoteAudio.play().catch(()=>{}), 50);
    }
  }
  else if (msg.type === "control:volume") {
    if (!isHost && remoteAudio.srcObject) {
      // Apply as *default* remote volume; user can override using Local volume
      if (!remoteAudio.dataset.userVolTouched) {
        remoteAudio.volume = Number(msg.volume);
      }
    }
  }
  else if (msg.type === "control:mute") {
    if (!isHost && remoteAudio.srcObject) {
      remoteAudio.muted = !!msg.muted;
    }
  }
  else if (msg.type === "host:you-are-now-host") {
    isHost = true;
    hostPanel.classList.remove("hidden");
    logChat("You are now the HOST. Load an audio file to start broadcasting.");
  }
  else if (msg.type === "host:attach-all") {
    if (isHost) hostAttachAll(msg.peers || []);
  }
  else if (msg.type === "room:kicked") {
    alert("You were kicked by the host.");
    location.reload();
  }
  else if (msg.type === "system") {
    logChat(`[system] ${msg.text}`);
  }
  else if (msg.type === "chat:new") {
    logChat(`${msg.from}: ${msg.text}`);
  }
  else if (msg.type === "pong") {
    const ms = Date.now() - msg.t;
    rttLabel.textContent = String(ms);
  }
};

// Track local user volume override
remoteAudio.addEventListener("volumechange", () => {
  remoteAudio.dataset.userVolTouched = "1";
});

// Basic RTT monitor
function pingLoop() {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
  setTimeout(pingLoop, 2000);
}