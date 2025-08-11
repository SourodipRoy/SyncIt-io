import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { v4 as uuid } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("public"));
app.get("/app", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

/**
 * rooms = {
 *   [roomId]: { pin, hostId, clients:Set, sockets:Map }
 * }
 */
const rooms = new Map();
/** clientId -> roomId */
const inRoom = new Map();
/** clientId -> display name */
const names = new Map();

const safe = (s="") => String(s).slice(0, 48).replace(/[<>\n\r]/g, "");
const shortId = (id="") => id.slice(0, 8);
const nameOf = (id) => (safe(names.get(id)) || `User-${shortId(id)}`);

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
function presencePayload(room) {
  const map = {};
  for (const cid of room.clients) map[cid] = nameOf(cid);
  return { clients: [...room.clients], hostId: room.hostId, names: map };
}

function dropClient(clientId) {
  const roomId = inRoom.get(clientId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.clients.delete(clientId);
  room.sockets.delete(clientId);
  inRoom.delete(clientId);

  if (room.hostId === clientId) {
    room.hostId = [...room.clients][0] || null;
    if (room.hostId) {
      safeSend(room.sockets.get(room.hostId), { type: "host:you-are-now-host" });
      safeSend(room.sockets.get(room.hostId), {
        type: "host:attach-all",
        peers: [...room.clients].filter(id => id !== room.hostId)
      });
      broadcast(roomId, { type: "system", text: `New host: ${nameOf(room.hostId)}` });
    } else {
      broadcast(roomId, { type: "system", text: "Host left. Room idle." });
    }
  }

  broadcast(roomId, { type: "presence:update", ...presencePayload(room) });
}

wss.on("connection", (ws) => {
  const clientId = uuid();
  safeSend(ws, { type: "hello", clientId });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // set/update display name
    if (data.type === "profile:set") {
      names.set(clientId, safe(data.name || ""));
      const rid = inRoom.get(clientId);
      if (rid) {
        const room = rooms.get(rid);
        broadcast(rid, { type: "presence:update", ...presencePayload(room) });
      }
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

      safeSend(ws, { type: "room:created", roomId, host: true, ...presencePayload(room) });
      broadcast(roomId, { type: "presence:update", ...presencePayload(room) });
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

      safeSend(ws, { type: "room:joined", roomId, host: room.hostId === clientId, hostId: room.hostId, ...presencePayload(room) });
      broadcast(roomId, { type: "presence:update", ...presencePayload(room) });

      if (room.hostId && room.hostId !== clientId) {
        safeSend(room.sockets.get(room.hostId), { type: "webrtc:new-peer", peerId: clientId });
      }
      broadcast(roomId, { type: "system", text: `${nameOf(clientId)} joined.` });
    }

    else if (data.type === "webrtc:signal") {
      const { targetId, payload } = data;
      const rid = inRoom.get(clientId);
      if (!rid) return;
      const room = rooms.get(rid);
      const target = room?.sockets.get(targetId);
      if (target) safeSend(target, { type: "webrtc:signal", fromId: clientId, payload });
    }

    else if (data.type === "control:playpause" ||
             data.type === "control:seek" ||
             data.type === "control:volume" ||
             data.type === "control:mute") {
      const rid = inRoom.get(clientId);
      const room = rooms.get(rid);
      if (room?.hostId !== clientId) return;
      broadcast(rid, { ...data, ts: Date.now() }, clientId);
    }

    else if (data.type === "host:transfer") {
      const rid = inRoom.get(clientId);
      const room = rooms.get(rid);
      if (!room || room.hostId !== clientId) return;
      const targetId = data.targetId;
      if (!room.clients.has(targetId)) return;

      room.hostId = targetId;
      safeSend(room.sockets.get(targetId), { type: "host:you-are-now-host" });
      safeSend(room.sockets.get(targetId), { type: "host:attach-all", peers: [...room.clients].filter(id => id !== targetId) });
      broadcast(rid, { type: "system", text: `Host transferred to ${nameOf(targetId)}` });
      broadcast(rid, { type: "presence:update", ...presencePayload(room) });
    }

    else if (data.type === "room:kick") {
      const rid = inRoom.get(clientId);
      const room = rooms.get(rid);
      if (!room || room.hostId !== clientId) return;
      const targetId = data.targetId;
      const sock = room.sockets.get(targetId);
      if (sock) safeSend(sock, { type: "room:kicked" });
      if (sock) sock.close(1000, "Kicked");
    }

    else if (data.type === "chat:send") {
      const rid = inRoom.get(clientId);
      if (!rid) return;
      broadcast(rid, { type: "chat:new", from: nameOf(clientId), text: String(data.text || "").slice(0, 500) });
    }

    else if (data.type === "ping") {
      safeSend(ws, { type: "pong", t: data.t });
    }
  });

  ws.on("close", () => dropClient(clientId));
  ws.on("error", () => dropClient(clientId));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running http://localhost:${PORT}`);
});