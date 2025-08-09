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
function updatePresence(list, host, usernames = {}) {
  hostLabel.textContent = host ? (usernames[host] || host.slice(0, 8)) : "—";
  clientsLabel.textContent = (list || []).map(id => usernames[id] || id.slice(0, 6)).join(", ") || "—";
  // update selects, exclude self
  transferSelect.innerHTML = "";
  kickSelect.innerHTML = "";
  (list || []).forEach(id => {
    if (id !== clientId) {
      const displayName = usernames[id] || id.slice(0, 8);
      const opt1 = document.createElement("option");
      opt1.value = id; opt1.text = displayName;
      transferSelect.appendChild(opt1);
      const opt2 = document.createElement("option");
      opt2.value = id; opt2.text = displayName;
      kickSelect.appendChild(opt2);
    }
  });
}

// Host: prepare capture + create sender PC per peer
async function ensureHostStream() {
  // Always create a fresh stream for new audio content
  // Use <audio>.captureStream() to grab decoded audio
  // This is supported on modern Chromium/Firefox. Safari 17+ generally OK.
  if (!audioEl.captureStream) {
    alert("Your browser does not support captureStream on <audio>. Try latest Chrome/Firefox.");
    throw new Error("captureStream unsupported");
  }
  
  const newStream = audioEl.captureStream();
  
  // Always update tracks for existing connections
  if (peers.size > 0) {
    const newAudioTrack = newStream.getAudioTracks()[0];
    
    if (newAudioTrack) {
      // Replace tracks in existing peer connections
      for (const [peerId, peerData] of peers) {
        try {
          const senders = peerData.pc.getSenders();
          const audioSender = senders.find(sender => 
            sender.track && sender.track.kind === 'audio'
          );
          
          if (audioSender) {
            await audioSender.replaceTrack(newAudioTrack);
          } else {
            // No audio sender found, add the track
            peerData.pc.addTrack(newAudioTrack, newStream);
          }
        } catch (e) {
          console.warn(`Failed to update track for peer ${peerId}:`, e);
          // If replace fails, recreate the connection
          await hostRecreatePeerConnection(peerId, newStream);
        }
      }
    }
  }
  
  stream = newStream;
  return stream;
}

async function hostRecreatePeerConnection(peerId, newStream) {
  // Close existing connection
  const existingPeer = peers.get(peerId);
  if (existingPeer) {
    existingPeer.pc.close();
  }
  
  // Create new connection
  const pcHost = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

  // Add all tracks to this connection
  newStream.getAudioTracks().forEach(tr => pcHost.addTrack(tr, newStream));

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

async function hostCreateSenderFor(peerId) {
  // Check if we already have a connection for this peer
  const existingPeer = peers.get(peerId);
  if (existingPeer && existingPeer.pc.connectionState === 'connected') {
    console.log(`Peer ${peerId} already connected, skipping.`);
    return;
  }
  
  // Close existing connection if it exists but is not connected
  if (existingPeer) {
    existingPeer.pc.close();
  }
  
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
  
  // Handle connection state changes
  pcHost.onconnectionstatechange = () => {
    console.log(`Peer ${peerId} connection state: ${pcHost.connectionState}`);
    if (pcHost.connectionState === 'failed' || pcHost.connectionState === 'disconnected') {
      // Try to reconnect after a short delay
      setTimeout(() => {
        if (peers.has(peerId)) {
          console.log(`Attempting to reconnect to peer ${peerId}`);
          hostCreateSenderFor(peerId);
        }
      }, 2000);
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
  if (pc && pc.connectionState === 'connected') return pc;
  
  // Close existing connection if it's not working
  if (pc) {
    pc.close();
  }
  
  pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

  pc.ontrack = (e) => {
    // e.streams[0] should have the host audio
    remoteAudio.srcObject = e.streams[0];
    logChat("Connected to host audio stream.");
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: hostId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };
  
  // Handle connection state changes
  pc.onconnectionstatechange = () => {
    console.log(`Listener connection state: ${pc.connectionState}`);
    if (pc.connectionState === 'connected') {
      logChat("Audio connection established with host.");
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      logChat("Audio connection lost. Waiting for reconnection...");
      // The host will send a new offer when they load new audio
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
  
  // Wait for audio to be ready, then update stream for all connected peers
  audioEl.addEventListener('loadeddata', async () => {
    try {
      await ensureHostStream();
      logChat(`New audio file loaded. Stream updated for all connected peers.`);
    } catch (e) {
      console.error('Failed to update stream:', e);
      logChat(`Warning: Failed to update audio stream for some peers.`);
    }
  }, { once: true });
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

// Keep connections alive when audio ends
audioEl.addEventListener("ended", () => {
  if (isHost && stream) {
    // Ensure stream stays active even when audio ends
    // This prevents WebRTC connections from closing
    setTimeout(async () => {
      try {
        await ensureHostStream();
        console.log("Stream refreshed after audio ended");
      } catch (e) {
        console.warn("Failed to refresh stream after audio ended:", e);
      }
    }, 100);
  }
});

// Listener local controls
localVol.oninput = () => {
  remoteAudio.volume = Number(localVol.value);
};
localMute.onclick = () => {
  remoteAudio.muted = !remoteAudio.muted;
};

// Step-by-step room flow
let currentStep = 'initial'; // 'initial', 'create-pin', 'join-details'

function showInitialStep() {
  $("username").style.display = "block";
  $("roomId").style.display = "none";
  $("pin").style.display = "none";
  $("createBtn").style.display = "inline-block";
  $("joinBtn").style.display = "inline-block";
  $("createBtn").textContent = "Create as Host";
  $("joinBtn").textContent = "Join Room";
  currentStep = 'initial';
}

function showCreatePinStep() {
  $("username").style.display = "none";
  $("roomId").style.display = "none";
  $("pin").style.display = "block";
  $("pin").placeholder = "Enter PIN (optional)";
  $("createBtn").textContent = "Create Room";
  $("joinBtn").textContent = "Skip PIN";
  currentStep = 'create-pin';
}

function showJoinDetailsStep() {
  $("username").style.display = "none";
  $("roomId").style.display = "block";
  $("pin").style.display = "block";
  $("pin").placeholder = "Enter PIN (if required)";
  $("createBtn").textContent = "Back";
  $("joinBtn").textContent = "Join Room";
  currentStep = 'join-details';
}

// Room create/join
$("createBtn").onclick = () => {
  if (currentStep === 'initial') {
    const username = $("username").value.trim();
    if (!username) {
      alert("Please enter a username");
      return;
    }
    showCreatePinStep();
  } else if (currentStep === 'create-pin') {
    const username = $("username").value.trim();
    const roomId = Math.floor(100000 + Math.random() * 900000).toString();
    
    ws.send(JSON.stringify({ 
      type: "room:create", 
      roomId: roomId, 
      pin: $("pin").value || null,
      username: username
    }));
  } else if (currentStep === 'join-details') {
    showInitialStep();
  }
};

$("joinBtn").onclick = () => {
  if (currentStep === 'initial') {
    const username = $("username").value.trim();
    if (!username) {
      alert("Please enter a username");
      return;
    }
    showJoinDetailsStep();
  } else if (currentStep === 'create-pin') {
    // Skip PIN for room creation
    const username = $("username").value.trim();
    const roomId = Math.floor(100000 + Math.random() * 900000).toString();
    
    ws.send(JSON.stringify({ 
      type: "room:create", 
      roomId: roomId, 
      pin: null,
      username: username
    }));
  } else if (currentStep === 'join-details') {
    const username = $("username").value.trim();
    const roomId = $("roomId").value.trim();
    
    if (!roomId || !/^\d{6}$/.test(roomId)) {
      alert("Room ID must be exactly 6 digits");
      return;
    }
    
    ws.send(JSON.stringify({ 
      type: "room:join", 
      roomId: roomId, 
      pin: $("pin").value || null,
      username: username
    }));
  }
};

// Initialize UI
showInitialStep();

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
    me.textContent = "";
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
    updatePresence(msg.clients, msg.hostId, msg.usernames || {});
    if (isHost) {
      hostPanel.classList.remove("hidden");
      logChat(`Joined ${roomId} as HOST.`);
    } else {
      hostPanel.classList.add("hidden");
      logChat(`Joined ${roomId} as listener.`);
    }
  }
  else if (msg.type === "presence:update") {
    updatePresence(msg.clients, msg.hostId, msg.usernames || {});
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
    logChat(`${msg.fromName || msg.from}: ${msg.text}`);
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