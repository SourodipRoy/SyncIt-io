import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("public"));

/**
 * rooms = {
 *   [roomId]: {
 *     pin: string|null,
 *     hostId: string|null,
 *     clients: Set(clientId),
 *     sockets: Map(clientId -> ws),
 *     usernames: Map(clientId -> username)
 *   }
 * }
 */
const rooms = new Map();
/** reverse index clientId -> roomId */
const inRoom = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { pin: null, hostId: null, clients: new Set(), sockets: new Map(), usernames: new Map() });
  }
  return rooms.get(roomId);
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomId, payload, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [cid, sock] of room.sockets.entries()) {
    if (cid === exceptId) continue;
    safeSend(sock, payload);
  }
}

function dropClient(clientId) {
  const roomId = inRoom.get(clientId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const ws = room.sockets.get(clientId);
  room.clients.delete(clientId);
  room.sockets.delete(clientId);
  room.usernames.delete(clientId); // Remove username as well
  inRoom.delete(clientId);

  // If host leaves, pick a new host (first client if any).
  if (room.hostId === clientId) {
    room.hostId = [...room.clients][0] || null;
    if (room.hostId) {
      safeSend(room.sockets.get(room.hostId), { type: "host:you-are-now-host" });
      broadcast(roomId, { type: "system", text: `New host: ${room.usernames.get(room.hostId)}` });
    } else {
      broadcast(roomId, { type: "system", text: "Host left. Room idle." });
    }
  }

  broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId, usernames: Object.fromEntries(room.usernames) });
}

wss.on("connection", (ws) => {
  const clientId = uuid();

  safeSend(ws, { type: "hello", clientId });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.type === "room:create") {
      let roomId = (data.roomId || "").trim();
      // Validate room ID to be 6 digits
      if (roomId && !/^\d{6}$/.test(roomId)) {
        return safeSend(ws, { type: "error", message: "Room ID must be a 6-digit number." });
      }
      if (!roomId) {
        roomId = Math.floor(100000 + Math.random() * 900000).toString(); // Generate a random 6-digit room ID
      }

      const room = getRoom(roomId);
      if (room.clients.size > 0) {
        return safeSend(ws, { type: "error", message: "Room already exists, pick another ID or join it." });
      }
      room.pin = data.pin || null;
      room.hostId = clientId;
      room.clients.add(clientId);
      room.sockets.set(clientId, ws);
      room.usernames.set(clientId, data.username || "Anonymous"); // Store username
      inRoom.set(clientId, roomId);
      safeSend(ws, { type: "room:created", roomId, host: true });
      broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId, usernames: Object.fromEntries(room.usernames) });
    }

    else if (data.type === "room:join") {
      const roomId = (data.roomId || "").trim();
      // Validate room ID to be 6 digits
      if (!/^\d{6}$/.test(roomId)) {
        return safeSend(ws, { type: "error", message: "Room ID must be a 6-digit number." });
      }
      if (!rooms.has(roomId)) return safeSend(ws, { type: "error", message: "Room not found." });

      const room = rooms.get(roomId);
      if (room.pin && room.pin !== data.pin) {
        return safeSend(ws, { type: "error", message: "Incorrect PIN." });
      }
      room.clients.add(clientId);
      room.sockets.set(clientId, ws);
      room.usernames.set(clientId, data.username || "Anonymous"); // Store username
      inRoom.set(clientId, roomId);

      safeSend(ws, { type: "room:joined", roomId, host: room.hostId === clientId, hostId: room.hostId, clients: [...room.clients] });
      broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId, usernames: Object.fromEntries(room.usernames) });

      // Ask host to create a WebRTC sender for this new peer
      if (room.hostId && room.hostId !== clientId) {
        safeSend(room.sockets.get(room.hostId), { type: "webrtc:new-peer", peerId: clientId });
      }
    }

    else if (data.type === "webrtc:signal") {
      // Forward generic signaling messages to a target
      const { targetId, payload } = data;
      const roomId = inRoom.get(clientId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      const target = room?.sockets.get(targetId);
      if (target) safeSend(target, { type: "webrtc:signal", fromId: clientId, payload });
    }

    // HOST actions broadcasted as control messages
    else if (data.type === "control:playpause") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (room?.hostId !== clientId) return;
      broadcast(roomId, { 
        type: "control:playpause", 
        state: data.state, 
        currentTime: data.currentTime,
        timestamp: data.timestamp,
        ts: Date.now() 
      }, clientId);
    }

    else if (data.type === "control:seek") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (room?.hostId !== clientId) return;
      broadcast(roomId, { 
        type: "control:seek", 
        time: data.time, 
        timestamp: data.timestamp,
        ts: Date.now() 
      }, clientId);
    }

    else if (data.type === "control:volume") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (room?.hostId !== clientId) return;
      broadcast(roomId, { 
        type: "control:volume", 
        volume: data.volume,
        timestamp: data.timestamp
      }, clientId);
    }

    else if (data.type === "control:mute") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (room?.hostId !== clientId) return;
      broadcast(roomId, { 
        type: "control:mute", 
        muted: data.muted,
        timestamp: data.timestamp
      }, clientId);
    }

    else if (data.type === "host:transfer") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (!room || room.hostId !== clientId) return;
      const targetId = data.targetId;
      if (!room.clients.has(targetId)) return;
      room.hostId = targetId;
      safeSend(room.sockets.get(targetId), { type: "host:you-are-now-host" });
      broadcast(roomId, { type: "system", text: `Host transferred to ${room.usernames.get(targetId)}` });
      broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId, usernames: Object.fromEntries(room.usernames) });
      // Tell new host to attach senders for everyone
      safeSend(room.sockets.get(targetId), { type: "host:attach-all", peers: [...room.clients].filter(id => id !== targetId) });
    }

    else if (data.type === "room:kick") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (!room || room.hostId !== clientId) return;
      const targetId = data.targetId;
      const sock = room.sockets.get(targetId);
      if (sock) safeSend(sock, { type: "room:kicked" });
      if (sock) sock.close(1000, "Kicked");
    }

    else if (data.type === "chat:send") {
      const roomId = inRoom.get(clientId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      const senderUsername = room.usernames.get(clientId) || "Anonymous";
      broadcast(roomId, { type: "chat:new", from: senderUsername, text: data.text }, null);
    }

    else if (data.type === "track:update") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (!room || room.hostId !== clientId) return;
      broadcast(roomId, { type: "track:update", trackInfo: data.trackInfo }, clientId);
    }

    else if (data.type === "playlist:update") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (!room || room.hostId !== clientId) return;
      broadcast(roomId, { type: "playlist:update", playlist: data.playlist, currentTrackIndex: data.currentTrackIndex }, clientId);
    }

    else if (data.type === "sync:full-state") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (!room || room.hostId !== clientId) return;
      broadcast(roomId, { type: "sync:full-state", ...data }, clientId);
    }

    else if (data.type === "sync:request-full-state") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (!room || !room.hostId || room.hostId === clientId) return;
      // Forward request to host
      const hostSocket = room.sockets.get(room.hostId);
      if (hostSocket) {
        safeSend(hostSocket, { type: "sync:request-full-state", requesterId: clientId });
      }
    }

    else if (data.type === "ping") {
      safeSend(ws, { type: "pong", t: data.t });
    }
  });

  ws.on("close", () => {
    dropClient(clientId);
  });

  ws.on("error", () => {
    dropClient(clientId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running http://localhost:${PORT}`);
});