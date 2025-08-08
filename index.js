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
 *     sockets: Map(clientId -> ws)
 *   }
 * }
 */
const rooms = new Map();
/** reverse index clientId -> roomId */
const inRoom = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { pin: null, hostId: null, clients: new Set(), sockets: new Map() });
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
  inRoom.delete(clientId);

  // If host leaves, pick a new host (first client if any).
  if (room.hostId === clientId) {
    room.hostId = [...room.clients][0] || null;
    if (room.hostId) {
      safeSend(room.sockets.get(room.hostId), { type: "host:you-are-now-host" });
      broadcast(roomId, { type: "system", text: `New host: ${room.hostId.slice(0, 8)}` });
    } else {
      broadcast(roomId, { type: "system", text: "Host left. Room idle." });
    }
  }

  broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId });
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
      const roomId = (data.roomId || "").trim() || Math.random().toString(36).slice(2, 8);
      const room = getRoom(roomId);
      if (room.clients.size > 0) {
        return safeSend(ws, { type: "error", message: "Room already exists, pick another ID or join it." });
      }
      room.pin = data.pin || null;
      room.hostId = clientId;
      room.clients.add(clientId);
      room.sockets.set(clientId, ws);
      inRoom.set(clientId, roomId);
      safeSend(ws, { type: "room:created", roomId, host: true });
      broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId });
    }

    else if (data.type === "room:join") {
      const roomId = (data.roomId || "").trim();
      if (!rooms.has(roomId)) return safeSend(ws, { type: "error", message: "Room not found." });

      const room = rooms.get(roomId);
      if (room.pin && room.pin !== data.pin) {
        return safeSend(ws, { type: "error", message: "Incorrect PIN." });
      }
      room.clients.add(clientId);
      room.sockets.set(clientId, ws);
      inRoom.set(clientId, roomId);

      safeSend(ws, { type: "room:joined", roomId, host: room.hostId === clientId, hostId: room.hostId, clients: [...room.clients] });
      broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId });

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
      broadcast(roomId, { type: "control:playpause", state: data.state, ts: Date.now() }, clientId);
    }

    else if (data.type === "control:seek") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (room?.hostId !== clientId) return;
      broadcast(roomId, { type: "control:seek", time: data.time, ts: Date.now() }, clientId);
    }

    else if (data.type === "control:volume") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (room?.hostId !== clientId) return;
      broadcast(roomId, { type: "control:volume", volume: data.volume }, clientId);
    }

    else if (data.type === "control:mute") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (room?.hostId !== clientId) return;
      broadcast(roomId, { type: "control:mute", muted: data.muted }, clientId);
    }

    else if (data.type === "host:transfer") {
      const roomId = inRoom.get(clientId);
      const room = rooms.get(roomId);
      if (!room || room.hostId !== clientId) return;
      const targetId = data.targetId;
      if (!room.clients.has(targetId)) return;
      room.hostId = targetId;
      safeSend(room.sockets.get(targetId), { type: "host:you-are-now-host" });
      broadcast(roomId, { type: "system", text: `Host transferred to ${targetId.slice(0,8)}` });
      broadcast(roomId, { type: "presence:update", clients: [...room.clients], hostId: room.hostId });
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
      broadcast(roomId, { type: "chat:new", from: clientId.slice(0, 6), text: data.text }, null);
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