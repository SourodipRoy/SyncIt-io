
const $ = (id) => document.getElementById(id);

// Page management
const pages = {
  landing: $("landingPage"),
  createRoom: $("createRoomPage"),
  joinRoom: $("joinRoomPage"),
  roomCreated: $("roomCreatedPage"),
  room: $("roomPage")
};

function showPage(pageName) {
  Object.values(pages).forEach(page => page.classList.add("hidden"));
  pages[pageName].classList.remove("hidden");
}

// WebSocket and room state
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
let clientId = null;
let roomId = null;
let isHost = false;
let hostId = null;
let currentTrackInfo = { title: "No track loaded", artist: "Select an audio file to start" };

// WebRTC
let pc = null;
const peers = new Map();
let stream = null;

// UI elements
const roomLabel = $("roomLabel");
const hostLabel = $("hostLabel");
const userCount = $("userCount");
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
const trackInfo = $("trackInfo");
const usersList = $("usersList");

// Landing page navigation
$("createRoomBtn").onclick = () => showPage("createRoom");
$("joinRoomBtn").onclick = () => showPage("joinRoom");
$("backToLanding1").onclick = () => showPage("landing");
$("backToLanding2").onclick = () => showPage("landing");

// Room creation flow
$("createRoomConfirm").onclick = () => {
  const username = $("hostUsername").value.trim();
  if (!username) {
    alert("Please enter your name");
    return;
  }
  
  const roomId = Math.floor(100000 + Math.random() * 900000).toString();
  const pin = $("roomPin").value.trim() || null;
  
  ws.send(JSON.stringify({
    type: "room:create",
    roomId: roomId,
    pin: pin,
    username: username
  }));
};

// Room joining flow
$("joinRoomConfirm").onclick = () => {
  const username = $("guestUsername").value.trim();
  const roomId = $("joinRoomId").value.trim();
  
  if (!username) {
    alert("Please enter your name");
    return;
  }
  
  if (!roomId || !/^\d{6}$/.test(roomId)) {
    alert("Room ID must be exactly 6 digits");
    return;
  }
  
  const pin = $("joinPin").value.trim() || null;
  
  ws.send(JSON.stringify({
    type: "room:join",
    roomId: roomId,
    pin: pin,
    username: username
  }));
};

// Room created success actions
$("copyRoomCode").onclick = () => {
  const code = $("createdRoomCode").textContent;
  navigator.clipboard.writeText(code).then(() => {
    $("copyRoomCode").textContent = "Copied!";
    setTimeout(() => {
      $("copyRoomCode").textContent = "Copy Code";
    }, 2000);
  });
};

$("enterRoom").onclick = () => {
  showPage("room");
  updateTrackDisplay();
};

$("leaveRoom").onclick = () => {
  location.reload();
};

// Utility functions
function logChat(message, sender = null) {
  const div = document.createElement("div");
  div.className = "chat-line";
  
  if (sender) {
    div.innerHTML = `
      <div class="chat-sender">${sender}</div>
      <div class="chat-message">${message}</div>
    `;
  } else {
    div.innerHTML = `<div class="chat-message">${message}</div>`;
  }
  
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function updateTrackDisplay() {
  if (trackInfo) {
    trackInfo.innerHTML = `
      <div class="track-title">${currentTrackInfo.title}</div>
      <div class="track-artist">${currentTrackInfo.artist}</div>
    `;
  }
}

function extractTrackInfo(file) {
  const fileName = file.name;
  const nameParts = fileName.replace(/\.[^/.]+$/, "").split(" - ");
  
  if (nameParts.length >= 2) {
    return {
      artist: nameParts[0].trim(),
      title: nameParts.slice(1).join(" - ").trim()
    };
  } else {
    return {
      artist: "Unknown Artist",
      title: nameParts[0].trim()
    };
  }
}

function updateUsersList(users, hostId, usernames = {}) {
  usersList.innerHTML = "";
  
  users.forEach(userId => {
    const username = usernames[userId] || "Anonymous";
    const isHostUser = userId === hostId;
    
    const userDiv = document.createElement("div");
    userDiv.className = "user-item";
    
    const initial = username.charAt(0).toUpperCase();
    
    userDiv.innerHTML = `
      <div class="user-avatar">${initial}</div>
      <div class="user-info">
        <div class="user-name">${username}</div>
        <div class="user-status">${isHostUser ? "Host" : "Listener"}</div>
      </div>
      ${isHostUser ? '<div class="host-badge">HOST</div>' : ""}
    `;
    
    usersList.appendChild(userDiv);
  });
  
  // Update user count
  userCount.textContent = `${users.length} user${users.length !== 1 ? "s" : ""}`;
}

// Presence UI
function updatePresence(list, host, usernames = {}) {
  hostLabel.textContent = host ? (usernames[host] || host.slice(0, 8)) : "—";
  
  // Update user list
  updateUsersList(list || [], host, usernames);
  
  // Update selects, exclude self
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
  if (!audioEl.captureStream) {
    alert("Your browser does not support captureStream on <audio>. Try latest Chrome/Firefox.");
    throw new Error("captureStream unsupported");
  }
  
  const newStream = audioEl.captureStream();
  
  if (peers.size > 0) {
    const newAudioTrack = newStream.getAudioTracks()[0];
    
    if (newAudioTrack) {
      for (const [peerId, peerData] of peers) {
        try {
          const senders = peerData.pc.getSenders();
          const audioSender = senders.find(sender => 
            sender.track && sender.track.kind === 'audio'
          );
          
          if (audioSender) {
            await audioSender.replaceTrack(newAudioTrack);
          } else {
            peerData.pc.addTrack(newAudioTrack, newStream);
          }
        } catch (e) {
          console.warn(`Failed to update track for peer ${peerId}:`, e);
          await hostRecreatePeerConnection(peerId, newStream);
        }
      }
    }
  }
  
  stream = newStream;
  return stream;
}

async function hostRecreatePeerConnection(peerId, newStream) {
  const existingPeer = peers.get(peerId);
  if (existingPeer) {
    existingPeer.pc.close();
  }
  
  const pcHost = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

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
  const existingPeer = peers.get(peerId);
  if (existingPeer && existingPeer.pc.connectionState === 'connected') {
    console.log(`Peer ${peerId} already connected, skipping.`);
    return;
  }
  
  if (existingPeer) {
    existingPeer.pc.close();
  }
  
  await ensureHostStream();
  const pcHost = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

  stream.getAudioTracks().forEach(tr => pcHost.addTrack(tr, stream));

  pcHost.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: peerId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };
  
  pcHost.onconnectionstatechange = () => {
    console.log(`Peer ${peerId} connection state: ${pcHost.connectionState}`);
    if (pcHost.connectionState === 'failed' || pcHost.connectionState === 'disconnected') {
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
  
  if (pc) {
    pc.close();
  }
  
  pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  });

  pc.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
    logChat("Connected to host audio stream.");
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: "webrtc:signal", targetId: hostId, payload: { kind: "ice", candidate: e.candidate } }));
    }
  };
  
  pc.onconnectionstatechange = () => {
    console.log(`Listener connection state: ${pc.connectionState}`);
    if (pc.connectionState === 'connected') {
      logChat("Audio connection established with host.");
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      logChat("Audio connection lost. Waiting for reconnection...");
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

// Host control bindings
fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  
  // Extract track info from filename
  const trackData = extractTrackInfo(f);
  currentTrackInfo = trackData;
  updateTrackDisplay();
  
  const url = URL.createObjectURL(f);
  audioEl.src = url;
  await audioEl.load();
  
  audioEl.addEventListener('loadeddata', async () => {
    try {
      await ensureHostStream();
      logChat(`New track loaded: ${currentTrackInfo.title} by ${currentTrackInfo.artist}`);
      
      // Broadcast track info to all clients
      ws.send(JSON.stringify({
        type: "track:update",
        trackInfo: currentTrackInfo
      }));
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
  muteBtn.textContent = audioEl.muted ? "🔇" : "🔊";
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

audioEl.addEventListener("ended", () => {
  if (isHost && stream) {
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
  localMute.textContent = remoteAudio.muted ? "🔇" : "🔊";
};

// Host actions
transferBtn.onclick = () => {
  const targetId = transferSelect.value;
  if (targetId) ws.send(JSON.stringify({ type: "host:transfer", targetId }));
};

kickBtn.onclick = () => {
  const targetId = kickSelect.value;
  if (targetId) {
    const targetName = kickSelect.options[kickSelect.selectedIndex].text;
    if (confirm(`Remove ${targetName} from the room?`)) {
      ws.send(JSON.stringify({ type: "room:kick", targetId }));
    }
  }
};

// Chat
chatSend.onclick = () => {
  const text = chatInput.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: "chat:send", text }));
  chatInput.value = "";
};

chatInput.onkeypress = (e) => {
  if (e.key === "Enter") {
    chatSend.onclick();
  }
};

// WebSocket message handling
ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);
  
  if (msg.type === "hello") {
    clientId = msg.clientId;
    pingLoop();
  }
  else if (msg.type === "error") {
    alert(msg.message);
  }
  else if (msg.type === "room:created") {
    roomId = msg.roomId;
    isHost = true;
    $("createdRoomCode").textContent = roomId;
    showPage("roomCreated");
    logChat(`Created room ${roomId}. You are host.`);
  }
  else if (msg.type === "room:joined") {
    roomId = msg.roomId;
    isHost = msg.host === true;
    hostId = msg.hostId || null;
    roomLabel.textContent = roomId;
    showPage("room");
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
  else if (msg.type === "track:update") {
    if (!isHost) {
      currentTrackInfo = msg.trackInfo;
      updateTrackDisplay();
      logChat(`Now playing: ${currentTrackInfo.title} by ${currentTrackInfo.artist}`);
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
    alert("You were removed from the room by the host.");
    location.reload();
  }
  else if (msg.type === "system") {
    logChat(`[SYSTEM] ${msg.text}`);
  }
  else if (msg.type === "chat:new") {
    logChat(msg.text, msg.from);
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

// Initialize
showPage("landing");
updateTrackDisplay();
