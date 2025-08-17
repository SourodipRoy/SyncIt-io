const $ = (id) => document.getElementById(id);

const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
let clientId = null;
let roomId = null;
let isHost = false;
let hostId = null;

let pc = null;                        // listener RTCPeerConnection
const peers = new Map();              // host: peerId -> { pc, negotiatedOnce }
let stream = null;                    // capture stream from <audio>
let currentTrack = null;              // audio track we send

// Playlist (host is source of truth)
let playlist = [];                    // host: [{id,name,url}], listeners: [{id,name}]
let currentIndex = -1;
let loopTrack = false;
let loopList = false;
let shuffleOn = false;

// URL params for auto create/join
let pendingURLAction = null;
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
const remoteAudio = $("remoteAudio");

// Now Playing UI
const npTitle = $("npTitle");
const npArtist = $("npArtist");

// media buttons
const prevBtn = $("prevBtn");
const playPauseBtn = $("playPauseBtn");
const nextBtn = $("nextBtn");

// playlist UI
const playlistEl = $("playlist");
const plLoopOneBtn = $("plLoopOne");
const plLoopAllBtn = $("plLoopAll");
const plShuffleBtn = $("plShuffle");
const plAddBtn = $("plAdd");

// copy room id
$("copyRoom")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomLabel.textContent.trim());
    const btn = $("copyRoom"); const old = btn.title;
    btn.title = "Copied!"; setTimeout(()=>btn.title=old, 900);
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

/* ----------- HOST: captureStream management + negotiation -------------- */
function getCaptureStream() {
  return audioEl.captureStream ? audioEl.captureStream()
       : audioEl.mozCaptureStream ? audioEl.mozCaptureStream()
       : null;
}
async function ensureHostStreamAndSync() {
  const cap = getCaptureStream();
  if (!cap) {
    alert("Your browser does not support captureStream on <audio>. Try latest Chrome/Firefox.");
    throw new Error("captureStream unsupported");
  }
  stream = cap;

  const newTrack = stream.getAudioTracks()[0] || null;
  if (!newTrack) return;

  const trackChanged = currentTrack !== newTrack;
  currentTrack = newTrack;

  for (const [peerId, obj] of peers.entries()) {
    const pcHost = obj.pc;
    try {
      let sender = pcHost.getSenders().find(s => s.track && s.track.kind === "audio");
      if (sender) {
        if (trackChanged) await sender.replaceTrack(currentTrack);
      } else {
        pcHost.addTrack(currentTrack, stream);
      }

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
async function hostCreateSenderFor(peerId) {
  const pcHost = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] });
  peers.set(peerId, { pc: pcHost, negotiatedOnce: false });

  pcHost.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: peerId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };

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

/* --------------------- Icons + mute toggle state ------------------------ */
const icons = {
  play:  '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7-11-7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>',
  volOn:'<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8a4 4 0 0 1 0 8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  volOff:'<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M19 9l-6 6M13 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  loopOne:'<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 7h10v4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M7 17h10v-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><text x="11" y="13" font-size="8" fill="currentColor">1</text></svg>',
  loopAll:'<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 7h10l-2-2M17 17H7l2 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  shuffle:'<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h5l3 4-3 4H4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16 7h4l-2-2m2 2l-2 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16 17h4l-2-2m2 2l-2 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  del:'<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 7h12M9 7v10m6-10v10M10 4h4l1 3H9l1-3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  up:'<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  down:'<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'
};
function setPlayPauseIcon() {
  const playing = !audioEl.paused && !audioEl.ended;
  playPauseBtn.innerHTML = playing ? icons.pause : icons.play;
  playPauseBtn.title = playing ? "Pause" : "Play";
  playPauseBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}
function setMuteIcon(){
  muteBtn.innerHTML = audioEl.muted ? icons.volOff : icons.volOn;
  muteBtn.title = audioEl.muted ? "Unmute" : "Mute";
  muteBtn.setAttribute("aria-label", muteBtn.title);
}

/* --------------------- Playlist helpers & rendering --------------------- */
function renderPlaylist() {
  playlistEl.innerHTML = "";
  playlist.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "pl-item" + (i === currentIndex ? " active" : "");
    row.dataset.index = String(i);

    const num = document.createElement("div");
    num.className = "pl-num";
    num.textContent = String(i + 1);

    const title = document.createElement("div");
    title.className = "pl-title";
    title.textContent = item.name || `Track ${i+1}`;

    const actions = document.createElement("div");
    actions.className = "pl-actions row gap";

    if (isHost) {
      const up = document.createElement("button");
      up.className = "icon-btn"; up.innerHTML = icons.up; up.title = "Move up";
      up.onclick = (e) => { e.stopPropagation(); moveItem(i, -1); };

      const down = document.createElement("button");
      down.className = "icon-btn"; down.innerHTML = icons.down; down.title = "Move down";
      down.onclick = (e) => { e.stopPropagation(); moveItem(i, +1); };

      const del = document.createElement("button");
      del.className = "icon-btn"; del.innerHTML = icons.del; del.title = "Remove";
      del.onclick = (e) => { e.stopPropagation(); removeItem(i); };

      actions.append(up, down, del);

      // Click anywhere on row to play
      row.onclick = () => playIndex(i, true);
      title.style.cursor = "pointer";
    }

    row.append(num, title, actions);
    playlistEl.appendChild(row);
  });

  // header icon states
  plLoopOneBtn.innerHTML = icons.loopOne;
  plLoopAllBtn.innerHTML = icons.loopAll;
  plShuffleBtn.innerHTML = icons.shuffle;
  plLoopOneBtn.style.color = loopTrack ? "white" : "var(--muted)";
  plLoopAllBtn.style.color = loopList ? "white" : "var(--muted)";
  plShuffleBtn.style.color = shuffleOn ? "white" : "var(--muted)";
}
function sendPlaylistState() {
  if (!isHost) return;
  const state = {
    list: playlist.map(({id, name}) => ({ id, name })),
    currentIndex, loopTrack, loopList, shuffle: shuffleOn
  };
  ws.send(JSON.stringify({ type: "playlist:state", state }));
}
function addFilesToPlaylist(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  files.forEach(f => {
    const url = URL.createObjectURL(f);
    playlist.push({ id: crypto.randomUUID(), name: f.name, url });
  });

  // Auto-start if nothing was playing
  if (currentIndex === -1) {
    currentIndex = 0;
    loadCurrentAndPlay(true);
  }

  renderPlaylist();
  sendPlaylistState();
}
function removeItem(i) {
  if (i < 0 || i >= playlist.length) return;
  const wasCurrent = i === currentIndex;
  playlist.splice(i, 1);
  if (playlist.length === 0) {
    currentIndex = -1;
    audioEl.pause();
    audioEl.removeAttribute("src");
    if (npTitle) npTitle.textContent = "No track selected";
  } else {
    if (wasCurrent) {
      if (i >= playlist.length) currentIndex = playlist.length - 1;
      loadCurrentAndPlay(true);
    } else if (i < currentIndex) {
      currentIndex -= 1;
    }
  }
  renderPlaylist();
  sendPlaylistState();
}
function moveItem(i, dir) {
  const j = i + dir;
  if (i < 0 || i >= playlist.length || j < 0 || j >= playlist.length) return;
  const [it] = playlist.splice(i, 1);
  playlist.splice(j, 0, it);
  if (currentIndex === i) currentIndex = j;
  else if (currentIndex === j) currentIndex = i;
  renderPlaylist();
  sendPlaylistState();
}
function nextIndex() {
  if (playlist.length === 0) return -1;
  if (loopTrack && currentIndex !== -1) return currentIndex;
  if (shuffleOn) {
    if (playlist.length === 1) return currentIndex;
    let r; do { r = Math.floor(Math.random()*playlist.length); } while (r === currentIndex);
    return r;
  }
  const n = currentIndex + 1;
  if (n < playlist.length) return n;
  return loopList ? 0 : -1;
}
function prevIndex() {
  if (playlist.length === 0) return -1;
  if (shuffleOn) {
    if (playlist.length === 1) return currentIndex;
    let r; do { r = Math.floor(Math.random()*playlist.length); } while (r === currentIndex);
    return r;
  }
  const p = currentIndex - 1;
  if (p >= 0) return p;
  return loopList ? playlist.length - 1 : -1;
}
function playIndex(i, autoplay=false) {
  if (!isHost) return;
  if (i < 0 || i >= playlist.length) return;
  currentIndex = i;
  loadCurrentAndPlay(autoplay);
  renderPlaylist();
  sendPlaylistState();
}

// helper to strip extension for nicer title
function stripExt(name=""){
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function loadCurrentAndPlay(autoplay) {
  if (currentIndex < 0 || currentIndex >= playlist.length) return;
  const item = playlist[currentIndex];
  if (!item) return;
  audioEl.src = item.url;

  // Update now playing tile
  if (npTitle) npTitle.textContent = stripExt(item.name || "No track selected");
  if (npArtist) npArtist.textContent = "Unknown Artist";

  const once = () => {
    audioEl.removeEventListener("loadedmetadata", once);
    ensureHostStreamAndSync().catch(console.error);
    if (autoplay) audioEl.play().catch(()=>{});
    setPlayPauseIcon();
  };
  audioEl.addEventListener("loadedmetadata", once);
  audioEl.load();
}

/* -------------------- Host controls & events ---------------------------- */
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
prevBtn.onclick = () => { if (!isHost) return; const i = prevIndex(); if (i !== -1) playIndex(i, true); };
nextBtn.onclick = () => { if (!isHost) return; const i = nextIndex(); if (i !== -1) playIndex(i, true); };

fileInput.onchange = () => { if (isHost) addFilesToPlaylist(fileInput.files); fileInput.value = ""; };
plAddBtn.onclick = () => fileInput.click();

plLoopOneBtn.onclick = () => { if (!isHost) return; loopTrack = !loopTrack; renderPlaylist(); sendPlaylistState(); };
plLoopAllBtn.onclick = () => { if (!isHost) return; loopList = !loopList; renderPlaylist(); sendPlaylistState(); };
plShuffleBtn.onclick = () => { if (!isHost) return; shuffleOn = !shuffleOn; renderPlaylist(); sendPlaylistState(); };

audioEl.addEventListener("ended", () => {
  if (!isHost) return;
  const i = nextIndex();
  if (i !== -1) playIndex(i, true);
  else setPlayPauseIcon();
});

audioEl.addEventListener("play", setPlayPauseIcon);
audioEl.addEventListener("pause", setPlayPauseIcon);
audioEl.addEventListener("canplay", () => { if (isHost) ensureHostStreamAndSync().catch(console.error); });

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
  setMuteIcon();
  ws.send(JSON.stringify({ type: "control:mute", muted: audioEl.muted }));
};
setMuteIcon();

/* --------------------- Chat -------------------------------------------- */
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
    setPlayPauseIcon(); setMuteIcon(); renderPlaylist();
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
    renderPlaylist();
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
  else if (msg.type === "playlist:state") {
    if (isHost) return; // host is authoritative, ignore echo
    const { list, currentIndex: idx, loopTrack: lt, loopList: ll, shuffle } = msg.state || {};
    playlist = (list || []).map(x => ({ id: x.id, name: x.name })); // no URLs on listeners
    currentIndex = (typeof idx === "number" ? idx : -1);
    loopTrack = !!lt; loopList = !!ll; shuffleOn = !!shuffle;
    renderPlaylist();
  }
  else if (msg.type === "playlist:request-state") {
    if (isHost) sendPlaylistState();
  }
  else if (msg.type === "host:you-are-now-host") {
    isHost = true;
    hostPanel.classList.remove("hidden");
    logChat("You are now the HOST. Load or pick a track to start broadcasting.");
    renderPlaylist(); setPlayPauseIcon(); setMuteIcon();
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