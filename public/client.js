// SyncIt client — no added latency. Uses <audio>.captureStream() with
// robust track replacement so:
//  - If host picks a file after peers join → everyone hears it
//  - If host changes files mid-session → everyone switches without refresh
//  - Late joiners get audio immediately
//  - No artificial sync delay nodes (host hears with minimal latency)

const $ = (id) => document.getElementById(id);

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
let clientId = null;
let roomId = null;
let isHost = false;
let hostId = null;

let pc = null;                        // listener RTCPeerConnection
const peers = new Map();              // host: peerId -> { pc }
let stream = null;                    // current capture stream from <audio>
let currentTrack = null;              // current audio track we send

// URL params for auto create/join
let pendingURLAction = null;          // { role, code, pin, user }
let displayName = "";

// UI references
const me = $("me");
const roomLabel = $("roomLabel");
const hostLabel = $("hostLabel");
const clientsLabel = $("clients");
const rttLabel = $("rtt");
const hostPanel = $("hostPanel");
const fileInput = $("fileInput");
const audioEl = $("audio");
const seek = $("seek");
const curTime = $("curTime");
const dur = $("dur");
const volume = $("volume");
const muteBtn = $("muteBtn");
const transferSelect = $("transferSelect");
const transferBtn = $("transferBtn");
const kickSelect = $("kickSelect");
const kickBtn = $("kickBtn");
const remoteAudio = $("remoteAudio"); // hidden element (listener fallback)

// media buttons
const prevBtn = $("prevBtn");
const playPauseBtn = $("playPauseBtn");
const nextBtn = $("nextBtn");

// copy room id
$("copyRoom")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomLabel.textContent.trim());
    const btn = $("copyRoom");
    const old = btn.title;
    btn.title = "Copied!";
    setTimeout(()=>btn.title=old, 900);
  } catch {}
});

// helpers
function logChat(line) {
  const div = document.createElement("div");
  div.className = "chat-line";
  div.textContent = line;
  const chatBox = $("chatBox");
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}
function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
function nameFrom(id, names) {
  return (names && names[id]) || (id ? `User-${id.slice(0,8)}` : "—");
}
function listParticipants(clients, hostId, names) {
  return (clients || []).map(id => {
    const arr = [nameFrom(id, names)];
    if (id === hostId) arr.push("(Host)");
    if (id === clientId) arr.push("(You)");
    return arr.join(" ");
  }).join(", ");
}
function updatePresence(payload) {
  const { clients, hostId: hId, names } = payload;
  hostId = hId;
  hostLabel.textContent = nameFrom(hostId, names);
  clientsLabel.textContent = listParticipants(clients, hostId, names);

  // update selects
  transferSelect.innerHTML = "";
  kickSelect.innerHTML = "";
  (clients || []).forEach(id => {
    if (id !== clientId) {
      const n = nameFrom(id, names);
      const o1 = document.createElement("option"); o1.value = id; o1.text = n; transferSelect.appendChild(o1);
      const o2 = document.createElement("option"); o2.value = id; o2.text = n; kickSelect.appendChild(o2);
    }
  });
}

/* ------------------ HOST: captureStream management ------------------ */
function getCaptureStream() {
  return audioEl.captureStream ? audioEl.captureStream()
       : audioEl.mozCaptureStream ? audioEl.mozCaptureStream()
       : null;
}

// Ensure we have a capture stream and the *current* audio track.
// If the track changed (new file), push it to all peers and renegotiate.
async function ensureHostStreamAndSync() {
  // 1) Ensure we have a capture stream
  const cap = getCaptureStream();
  if (!cap) {
    alert("Your browser does not support captureStream on <audio>. Try latest Chrome/Firefox.");
    throw new Error("captureStream unsupported");
  }
  stream = cap;

  // 2) Grab the active track (may change when src changes)
  const newTrack = stream.getAudioTracks()[0] || null;
  if (!newTrack) return;

  const trackChanged = currentTrack !== newTrack;
  currentTrack = newTrack;

  // 3) Push to existing peers (replaceTrack if sender exists; else addTrack) + renegotiate
  for (const [peerId, obj] of peers.entries()) {
    const pcHost = obj.pc;
    try {
      let sender = pcHost.getSenders().find(s => s.track && s.track.kind === "audio");
      if (sender) {
        if (trackChanged) await sender.replaceTrack(currentTrack);
      } else {
        pcHost.addTrack(currentTrack, stream);
      }
      // (Re)negotiate if this is the first time or track changed
      if (trackChanged || !obj.negotiatedOnce) {
        const offer = await pcHost.createOffer({ offerToReceiveAudio: false });
        await pcHost.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "webrtc:signal", targetId: peerId, payload: { kind: "offer", sdp: offer } }));
        obj.negotiatedOnce = true;
      }
    } catch (e) {
      console.error("ensureHostStreamAndSync -> peer failed", peerId, e);
    }
  }
}

// Create sender PC for a new peer (attach current track if present)
async function hostCreateSenderFor(peerId) {
  const pcHost = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
  peers.set(peerId, { pc: pcHost, negotiatedOnce: false });

  pcHost.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: peerId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };

  // Attach if we already have a track; if not, the next ensureHostStreamAndSync() will add+renegotiate
  const cap = getCaptureStream();
  if (cap) {
    stream = cap;
    const tr = stream.getAudioTracks()[0];
    if (tr) {
      currentTrack = tr;
      pcHost.addTrack(tr, stream);
    }
  }

  const offer = await pcHost.createOffer({ offerToReceiveAudio: false });
  await pcHost.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "webrtc:signal", targetId: peerId, payload: { kind: "offer", sdp: offer } }));
  peers.get(peerId).negotiatedOnce = true;
}

async function hostAttachAll(peerIds) {
  for (const pid of peerIds) {
    try { await hostCreateSenderFor(pid); } catch (e) { console.error(e); }
  }
}

/* ------------------------- LISTENER: single PC --------------------------- */
async function ensureListenerPC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
  pc.ontrack = (e) => { remoteAudio.srcObject = e.streams[0]; remoteAudio.play().catch(()=>{}); };
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: hostId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };
  return pc;
}
async function listenerHandleOffer(fromId, sdp) {
  hostId = fromId;
  const pc = await ensureListenerPC();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: "webrtc:signal", targetId: fromId, payload: { kind: "answer", sdp: answer } }));
}

/* --------------------- Host controls: icon buttons ----------------------- */
const icons = {
  play:  '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7-11-7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>'
};
function setPlayPauseIcon() {
  const playing = !audioEl.paused && !audioEl.ended;
  playPauseBtn.innerHTML = playing ? icons.pause : icons.play;
  playPauseBtn.title = playing ? "Pause" : "Play";
  playPauseBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  audioEl.src = url;
  // Wait for metadata so captureStream has a live track, then sync to peers
  const once = () => {
    audioEl.removeEventListener("loadedmetadata", once);
    ensureHostStreamAndSync().catch(console.error);
    setPlayPauseIcon();
  };
  audioEl.addEventListener("loadedmetadata", once);
  await audioEl.load();
};
// Also catch canplay (some engines expose track there)
audioEl.addEventListener("canplay", () => { if (isHost) ensureHostStreamAndSync().catch(console.error); });

// Play/Pause
playPauseBtn.onclick = async () => {
  if (audioEl.paused) {
    try { await audioEl.play(); } catch {}
    ws.send(JSON.stringify({ type: "control:playpause", state: "play" }));
  } else {
    audioEl.pause();
    ws.send(JSON.stringify({ type: "control:playpause", state: "pause" }));
  }
  setPlayPauseIcon();
};
prevBtn.onclick = () => {};
nextBtn.onclick = () => {};
audioEl.addEventListener("play", setPlayPauseIcon);
audioEl.addEventListener("pause", setPlayPauseIcon);
audioEl.addEventListener("ended", setPlayPauseIcon);

// Seek / volume / mute
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
volume.oninput = () => {
  audioEl.volume = Number(volume.value);
  ws.send(JSON.stringify({ type: "control:volume", volume: Number(volume.value) }));
};
muteBtn.onclick = () => {
  audioEl.muted = !audioEl.muted;
  ws.send(JSON.stringify({ type: "control:mute", muted: audioEl.muted }));
};

// Chat
const chatBox = $("chatBox");
const chatInput = $("chatInput");
const chatSend = $("chatSend");
chatSend.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: "chat:send", text }));
  chatInput.value = "";
};

/* ---------------------------- WS events -------------------------------- */
ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === "hello") {
    clientId = msg.clientId;
    if (displayName) ws.send(JSON.stringify({ type: "profile:set", name: displayName }));
    me.textContent = displayName ? `You: ${displayName}` : `You: ${clientId.slice(0, 8)}`;
    setTimeout(attemptAutoAction, 0);
    pingLoop();
  }
  else if (msg.type === "error") {
    alert(msg.message);
  }
  else if (msg.type === "room:created") {
    roomId = msg.roomId; isHost = true;
    roomLabel.textContent = roomId;
    hostPanel.classList.remove("hidden");
    updatePresence(msg);
    logChat(`Created room ${roomId}. You are host.`);
    setPlayPauseIcon();
  }
  else if (msg.type === "room:joined") {
    roomId = msg.roomId; isHost = msg.host === true;
    roomLabel.textContent = roomId;
    updatePresence(msg);
    if (isHost) {
      hostPanel.classList.remove("hidden");
      logChat(`Joined ${roomId} as HOST.`);
    } else {
      hostPanel.classList.add("hidden");
      logChat(`Joined ${roomId} as listener.`);
    }
  }
  else if (msg.type === "presence:update") {
    updatePresence(msg);
  }
  else if (msg.type === "webrtc:new-peer") {
    if (isHost) hostCreateSenderFor(msg.peerId);
  }
  else if (msg.type === "webrtc:signal") {
    const { fromId, payload } = msg;
    if (payload.kind === "offer") {
      await listenerHandleOffer(fromId, payload.sdp);
    } else if (payload.kind === "answer") {
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
    if (!isHost && remoteAudio.srcObject) {
      // best-effort nudge for live streams
      remoteAudio.pause();
      setTimeout(() => remoteAudio.play().catch(()=>{}), 50);
    }
  }
  else if (msg.type === "control:volume") {
    if (!isHost && remoteAudio.srcObject) {
      remoteAudio.volume = Number(msg.volume);
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
    setPlayPauseIcon();
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

/* ------------------------- Auto create/join ------------------------------ */
function attemptAutoAction(){
  if (!pendingURLAction || !clientId || ws.readyState !== WebSocket.OPEN) return;
  const { role, code, pin } = pendingURLAction;
  if (!code || !role) return;
  if (role === "create") {
    ws.send(JSON.stringify({ type: "room:create", roomId: code, pin: pin || null }));
  } else if (role === "join") {
    ws.send(JSON.stringify({ type: "room:join", roomId: code, pin: pin || null }));
  }
  pendingURLAction = null;
}

/* ----------------------------- Ping loop -------------------------------- */
function pingLoop() {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
  setTimeout(pingLoop, 2000);
}

/* ---- URL params ---- */
window.addEventListener("DOMContentLoaded", () => {
  const u = new URL(location.href);
  const role = (u.searchParams.get("role") || "").toLowerCase();
  const code = u.searchParams.get("code") || "";
  const pin = u.searchParams.get("pin") || "";
  displayName = u.searchParams.get("user") || "";
  pendingURLAction = { role, code, pin, user: displayName };
  if (!role || !code) logChat("Open the landing page to create or join a room.");
});
