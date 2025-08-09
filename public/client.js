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
let playlist = [];
let currentTrackIndex = -1;
let loopQueue = false;
let loopSong = false;
let shuffleMode = false;
let shuffleHistory = [];
let reorderMode = false;

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
const prevBtn = $("prevBtn");
const nextBtn = $("nextBtn");
const seek = $("seek");
const curTime = $("curTime");
const dur = $("dur");
const volume = $("volume");
const muteBtn = $("muteBtn");
const playbackControlsSection = $("playbackControlsSection");
const masterVolumeSection = $("masterVolumeSection");
const playlistFileInput = $("playlistFileInput");
const addFilesBtn = $("addFilesBtn");
const playlistContainer = $("playlistContainer");
const playlistEmpty = $("playlistEmpty");
const playlistItems = $("playlistItems");
const loopQueueBtn = $("loopQueueBtn");
const loopSongBtn = $("loopSongBtn");
const shuffleBtn = $("shuffleBtn");
const reorderBtn = $("reorderBtn");
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

function addToPlaylist(files) {
  if (!isHost) return; // Only host can add files
  
  const supportedTypes = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/webm'];
  let hasErrors = false;

  Array.from(files).forEach(file => {
    if (!supportedTypes.some(type => file.type.startsWith(type.split('/')[0]))) {
      showPlaylistError(`Unsupported file type: ${file.name}`);
      hasErrors = true;
      return;
    }

    const trackInfo = extractTrackInfo(file);
    let title = trackInfo.title;

    // Handle duplicate names
    let counter = 2;
    const originalTitle = title;
    while (playlist.some(item => item.title === title)) {
      title = `${originalTitle} (${counter})`;
      counter++;
    }

    const playlistItem = {
      id: Date.now() + Math.random(),
      title: title,
      artist: trackInfo.artist,
      filename: file.name,
      file: file,
      url: URL.createObjectURL(file)
    };

    playlist.push(playlistItem);
  });

  updatePlaylistDisplay();
  if (!hasErrors && files.length > 0) {
    hidePlaylistError();
    // Broadcast updated playlist to all clients
    broadcastPlaylistUpdate();
  }
}

function broadcastPlaylistUpdate() {
  if (!isHost) return;
  
  const playlistData = playlist.map(item => ({
    id: item.id,
    title: item.title,
    artist: item.artist,
    filename: item.filename
  }));
  
  ws.send(JSON.stringify({
    type: "playlist:update",
    playlist: playlistData,
    currentTrackIndex: currentTrackIndex
  }));
}

function receivePlaylistUpdate(playlistData, trackIndex) {
  if (isHost) return; // Host manages their own playlist
  
  // Clear existing playlist URLs for listeners
  playlist.forEach(item => {
    if (item.url) URL.revokeObjectURL(item.url);
  });
  
  // Update playlist (listeners won't have file objects)
  playlist = playlistData.map(item => ({
    ...item,
    file: null,
    url: null
  }));
  
  currentTrackIndex = trackIndex;
  updatePlaylistDisplay();
}

function showPlaylistError(message) {
  let errorDiv = playlistContainer.querySelector('.playlist-error');
  if (!errorDiv) {
    errorDiv = document.createElement('div');
    errorDiv.className = 'playlist-error';
    playlistContainer.insertBefore(errorDiv, playlistItems);
  }
  errorDiv.textContent = message;
  setTimeout(hidePlaylistError, 5000);
}

function hidePlaylistError() {
  const errorDiv = playlistContainer.querySelector('.playlist-error');
  if (errorDiv) {
    errorDiv.remove();
  }
}

function updatePlaylistDisplay() {
  if (playlist.length === 0) {
    playlistEmpty.style.display = 'block';
    playlistItems.style.display = 'none';
    return;
  }

  playlistEmpty.style.display = 'none';
  playlistItems.style.display = 'block';
  playlistItems.innerHTML = '';

  playlist.forEach((item, index) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = `playlist-item ${index === currentTrackIndex ? 'playing' : ''} ${reorderMode ? 'reorder-mode' : ''}`;
    itemDiv.draggable = reorderMode;

    itemDiv.innerHTML = `
      <div class="playlist-index">${index + 1}.</div>
      <div class="playlist-info">
        <div class="playlist-title">${item.title}</div>
        <div class="playlist-filename">${item.filename}</div>
      </div>
      <button class="playlist-remove" title="Remove track">🗑️</button>
    `;

    // Click to play (host only)
    itemDiv.addEventListener('click', (e) => {
      if (!e.target.closest('.playlist-remove') && !reorderMode && isHost) {
        playTrack(index);
      }
    });

    // Remove button (host only)
    const removeBtn = itemDiv.querySelector('.playlist-remove');
    if (isHost) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromPlaylist(index);
        broadcastPlaylistUpdate();
      });
    } else {
      removeBtn.style.display = 'none'; // Hide remove button for listeners
    }

    // Drag and drop for reordering
    if (reorderMode) {
      itemDiv.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', index);
        itemDiv.style.opacity = '0.5';
      });

      itemDiv.addEventListener('dragend', () => {
        itemDiv.style.opacity = '1';
      });

      itemDiv.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      itemDiv.addEventListener('drop', (e) => {
        e.preventDefault();
        const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
        const dropIndex = index;

        if (dragIndex !== dropIndex) {
          reorderPlaylist(dragIndex, dropIndex);
        }
      });
    }

    playlistItems.appendChild(itemDiv);
  });
}

function removeFromPlaylist(index) {
  URL.revokeObjectURL(playlist[index].url);
  playlist.splice(index, 1);

  // Adjust current track index
  if (currentTrackIndex === index) {
    currentTrackIndex = -1;
  } else if (currentTrackIndex > index) {
    currentTrackIndex--;
  }

  updatePlaylistDisplay();
}

function reorderPlaylist(fromIndex, toIndex) {
  const item = playlist.splice(fromIndex, 1)[0];
  playlist.splice(toIndex, 0, item);

  // Adjust current track index
  if (currentTrackIndex === fromIndex) {
    currentTrackIndex = toIndex;
  } else if (currentTrackIndex > fromIndex && currentTrackIndex <= toIndex) {
    currentTrackIndex--;
  } else if (currentTrackIndex < fromIndex && currentTrackIndex >= toIndex) {
    currentTrackIndex++;
  }

  updatePlaylistDisplay();
}

function playTrack(index) {
  if (!isHost) return; // Only host can control playback
  if (index < 0 || index >= playlist.length) return;

  currentTrackIndex = index;
  const track = playlist[index];
  currentTrackInfo = { title: track.title, artist: track.artist };

  audioEl.src = track.url;
  audioEl.load();

  audioEl.addEventListener('loadeddata', async () => {
    try {
      await ensureHostStream();
      logChat(`Playing: ${track.title} by ${track.artist}`);
      
      // Update track display
      updateTrackDisplay();

      // Broadcast complete state to all clients
      broadcastFullState();
      updatePlaylistDisplay();
      
      // Also broadcast track info separately for immediate update
      ws.send(JSON.stringify({
        type: "track:update",
        trackInfo: currentTrackInfo
      }));
    } catch (e) {
      console.error('Failed to update stream:', e);
    }
  }, { once: true });
}

function broadcastFullState() {
  if (!isHost) return;
  
  ws.send(JSON.stringify({
    type: "sync:full-state",
    trackInfo: currentTrackInfo,
    currentTrackIndex: currentTrackIndex,
    playlist: playlist.map(item => ({
      id: item.id,
      title: item.title,
      artist: item.artist,
      filename: item.filename
    })),
    isPlaying: !audioEl.paused,
    currentTime: audioEl.currentTime,
    volume: audioEl.volume,
    muted: audioEl.muted,
    timestamp: Date.now()
  }));
}

function syncToHostState(state) {
  if (isHost) return; // Host doesn't sync to itself
  
  // Update track info
  currentTrackInfo = state.trackInfo;
  currentTrackIndex = state.currentTrackIndex;
  
  // Update playlist
  receivePlaylistUpdate(state.playlist, state.currentTrackIndex);
  
  // Update display
  updateTrackDisplay();
  
  // Sync playback state (listeners use remote audio)
  if (remoteAudio && remoteAudio.srcObject) {
    const timeDiff = (Date.now() - state.timestamp) / 1000;
    const syncTime = state.currentTime + timeDiff;
    
    if (Math.abs(remoteAudio.currentTime - syncTime) > 0.5) {
      // Only seek if significantly out of sync
      remoteAudio.currentTime = syncTime;
    }
    
    if (state.isPlaying && remoteAudio.paused) {
      remoteAudio.play().catch(console.warn);
    } else if (!state.isPlaying && !remoteAudio.paused) {
      remoteAudio.pause();
    }
  } else if (state.isPlaying) {
    // If we don't have audio stream yet but should be playing, log this
    console.log("Should be playing but no audio stream available yet");
  }
  
  logChat(`Synced: ${currentTrackInfo.title} by ${currentTrackInfo.artist}`);
}

function playNext() {
  if (!isHost || playlist.length === 0) return;

  let nextIndex;

  if (shuffleMode) {
    const availableIndices = playlist.map((_, i) => i).filter(i => !shuffleHistory.includes(i));
    if (availableIndices.length === 0) {
      shuffleHistory = [];
      availableIndices = playlist.map((_, i) => i);
    }
    nextIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
    shuffleHistory.push(nextIndex);
    if (shuffleHistory.length > playlist.length) {
      shuffleHistory.shift();
    }
  } else {
    nextIndex = currentTrackIndex + 1;
    if (nextIndex >= playlist.length) {
      if (loopQueue) {
        nextIndex = 0;
      } else {
        return;
      }
    }
  }

  playTrack(nextIndex);
}

function playPrevious() {
  if (!isHost || playlist.length === 0) return;

  let prevIndex;

  if (shuffleMode && shuffleHistory.length > 1) {
    shuffleHistory.pop(); // Remove current
    prevIndex = shuffleHistory[shuffleHistory.length - 1];
  } else {
    prevIndex = currentTrackIndex - 1;
    if (prevIndex < 0) {
      if (loopQueue) {
        prevIndex = playlist.length - 1;
      } else {
        return;
      }
    }
  }

  playTrack(prevIndex);
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

// File upload handler function (legacy - now uses playlist)
async function handleFileUpload(file) {
  if (!file) return;
  const wasEmpty = playlist.length === 0;
  addToPlaylist([file]);
  if (wasEmpty && playlist.length > 0) {
    // Auto-play first track when playlist was empty
    setTimeout(() => playTrack(0), 100);
  }
}

// Host control bindings
fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  await handleFileUpload(f);
};

// Drag and drop functionality
const fileUploadArea = $("fileUploadArea");

if (fileUploadArea) {
  // Prevent default drag behaviors
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    fileUploadArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  // Highlight drop area when item is dragged over it
  ['dragenter', 'dragover'].forEach(eventName => {
    fileUploadArea.addEventListener(eventName, () => {
      fileUploadArea.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    fileUploadArea.addEventListener(eventName, () => {
      fileUploadArea.classList.remove('drag-over');
    });
  });

  // Handle dropped files
  fileUploadArea.addEventListener('drop', async (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await handleFileUpload(files[0]);
    }
  });

  // Make the entire area clickable
  fileUploadArea.addEventListener('click', () => {
    fileInput.click();
  });
}

// Playlist control event listeners (host only)
addFilesBtn.onclick = () => {
  if (!isHost) return;
  playlistFileInput.click();
};

playlistFileInput.onchange = () => {
  if (!isHost || !playlistFileInput.files?.length) return;
  const wasEmpty = playlist.length === 0;
  addToPlaylist(playlistFileInput.files);
  playlistFileInput.value = ''; // Reset input
  
  if (wasEmpty && playlist.length > 0) {
    // Auto-play first track when playlist was empty
    setTimeout(() => playTrack(0), 100);
  }
};

loopQueueBtn.onclick = () => {
  loopQueue = !loopQueue;
  loopQueueBtn.classList.toggle('active', loopQueue);
};

loopSongBtn.onclick = () => {
  loopSong = !loopSong;
  loopSongBtn.classList.toggle('active', loopSong);
};

shuffleBtn.onclick = () => {
  shuffleMode = !shuffleMode;
  shuffleBtn.classList.toggle('active', shuffleMode);
  if (shuffleMode) {
    shuffleHistory = currentTrackIndex >= 0 ? [currentTrackIndex] : [];
  }
};

reorderBtn.onclick = () => {
  reorderMode = !reorderMode;
  reorderBtn.classList.toggle('active', reorderMode);
  updatePlaylistDisplay();
};

// Playback controls (host only)
playBtn.onclick = async () => {
  if (!isHost) return;
  await audioEl.play();
  ws.send(JSON.stringify({ 
    type: "control:playpause", 
    state: "play",
    timestamp: Date.now(),
    currentTime: audioEl.currentTime
  }));
};

pauseBtn.onclick = () => {
  if (!isHost) return;
  audioEl.pause();
  ws.send(JSON.stringify({ 
    type: "control:playpause", 
    state: "pause",
    timestamp: Date.now(),
    currentTime: audioEl.currentTime
  }));
};

stopBtn.onclick = () => {
  if (!isHost) return;
  audioEl.pause();
  audioEl.currentTime = 0;
  ws.send(JSON.stringify({ 
    type: "control:seek", 
    time: 0,
    timestamp: Date.now()
  }));
  ws.send(JSON.stringify({ 
    type: "control:playpause", 
    state: "pause",
    timestamp: Date.now(),
    currentTime: 0
  }));
};

prevBtn.onclick = () => {
  if (!isHost) return;
  playPrevious();
};

nextBtn.onclick = () => {
  if (!isHost) return;
  playNext();
};

volume.oninput = () => {
  if (!isHost) return;
  audioEl.volume = Number(volume.value);
  ws.send(JSON.stringify({ 
    type: "control:volume", 
    volume: Number(volume.value),
    timestamp: Date.now()
  }));
};

muteBtn.onclick = () => {
  if (!isHost) return;
  audioEl.muted = !audioEl.muted;
  ws.send(JSON.stringify({ 
    type: "control:mute", 
    muted: audioEl.muted,
    timestamp: Date.now()
  }));
  muteBtn.textContent = audioEl.muted ? "🔇" : "🔊";
};

seek.oninput = () => {
  if (!audioEl.duration || !isHost) return;
  const t = (Number(seek.value) / 100) * audioEl.duration;
  audioEl.currentTime = t;
  ws.send(JSON.stringify({ 
    type: "control:seek", 
    time: t,
    timestamp: Date.now()
  }));
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
  if (isHost) {
    if (loopSong) {
      audioEl.currentTime = 0;
      audioEl.play();
      ws.send(JSON.stringify({ type: "control:seek", time: 0 }));
      ws.send(JSON.stringify({ type: "control:playpause", state: "play" }));
    } else {
      playNext();
    }

    if (stream) {
      setTimeout(async () => {
        try {
          await ensureHostStream();
          console.log("Stream refreshed after audio ended");
        } catch (e) {
          console.warn("Failed to refresh stream after audio ended:", e);
        }
      }, 100);
    }
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
      // Show host-only controls
      document.querySelectorAll('.host-only-control').forEach(el => el.classList.remove('hidden'));
      // Hide listener-only controls
      document.querySelectorAll('.listener-only-control').forEach(el => el.classList.add('hidden'));
      // Show playlist controls for host
      addFilesBtn.style.display = 'block';
      document.querySelectorAll('.toolbar-btn').forEach(btn => btn.style.display = 'block');
      logChat(`Joined ${roomId} as HOST.`);
    } else {
      hostPanel.classList.add("hidden");
      // Hide host-only controls
      document.querySelectorAll('.host-only-control').forEach(el => el.classList.add('hidden'));
      // Show listener-only controls
      document.querySelectorAll('.listener-only-control').forEach(el => el.classList.remove('hidden'));
      // Hide playlist controls for listeners
      addFilesBtn.style.display = 'none';
      document.querySelectorAll('.toolbar-btn').forEach(btn => btn.style.display = 'none');
      logChat(`Joined ${roomId} as listener.`);
      
      // Request full state sync from host
      ws.send(JSON.stringify({ type: "sync:request-full-state" }));
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
      const timeDiff = (Date.now() - msg.timestamp) / 1000;
      const syncTime = msg.currentTime + timeDiff;
      
      if (msg.state === "play") {
        if (Math.abs(remoteAudio.currentTime - syncTime) > 0.2) {
          remoteAudio.currentTime = syncTime;
        }
        remoteAudio.play().catch(()=>{});
      }
      if (msg.state === "pause") {
        remoteAudio.pause();
      }
    }
  }
  else if (msg.type === "control:seek") {
    if (!isHost && remoteAudio.srcObject) {
      const timeDiff = (Date.now() - msg.timestamp) / 1000;
      const syncTime = msg.time + timeDiff;
      remoteAudio.currentTime = syncTime;
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
  else if (msg.type === "sync:full-state") {
    syncToHostState(msg);
  }
  else if (msg.type === "playlist:update") {
    receivePlaylistUpdate(msg.playlist, msg.currentTrackIndex);
  }
  else if (msg.type === "track:update") {
    if (!isHost) {
      currentTrackInfo = msg.trackInfo;
      updateTrackDisplay();
      logChat(`Now playing: ${currentTrackInfo.title} by ${currentTrackInfo.artist}`);
      
      // Ensure remote audio is ready to play
      if (remoteAudio && remoteAudio.srcObject && remoteAudio.paused) {
        remoteAudio.play().catch(console.warn);
      }
    }
  }
  else if (msg.type === "host:you-are-now-host") {
    isHost = true;
    hostPanel.classList.remove("hidden");
    // Show host-only controls
    document.querySelectorAll('.host-only-control').forEach(el => el.classList.remove('hidden'));
    // Hide listener-only controls
    document.querySelectorAll('.listener-only-control').forEach(el => el.classList.add('hidden'));
    // Show playlist controls for new host
    addFilesBtn.style.display = 'block';
    document.querySelectorAll('.toolbar-btn').forEach(btn => btn.style.display = 'block');
    logChat("You are now the HOST. Add tracks to playlist to start broadcasting.");
    
    // Immediately broadcast current state to all listeners
    setTimeout(() => broadcastFullState(), 100);
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
  else if (msg.type === "sync:request-full-state") {
    if (isHost && msg.requesterId) {
      // Send full state to specific requester
      const fullState = {
        type: "sync:full-state",
        trackInfo: currentTrackInfo,
        currentTrackIndex: currentTrackIndex,
        playlist: playlist.map(item => ({
          id: item.id,
          title: item.title,
          artist: item.artist,
          filename: item.filename
        })),
        isPlaying: !audioEl.paused,
        currentTime: audioEl.currentTime,
        volume: audioEl.volume,
        muted: audioEl.muted,
        timestamp: Date.now(),
        targetId: msg.requesterId
      };
      ws.send(JSON.stringify(fullState));
    }
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
updatePlaylistDisplay();