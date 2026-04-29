const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const rooms = new Map();

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendFrame(socket, data) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function readFrames(socket, chunk) {
  socket.buffer = Buffer.concat([socket.buffer || Buffer.alloc(0), chunk]);
  const messages = [];

  while (socket.buffer.length >= 2) {
    const first = socket.buffer[0];
    const second = socket.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (socket.buffer.length < 4) break;
      length = socket.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (socket.buffer.length < 10) break;
      length = Number(socket.buffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskOffset = masked ? 4 : 0;
    const total = offset + maskOffset + length;
    if (socket.buffer.length < total) break;

    if (opcode === 0x8) {
      socket.end();
      return messages;
    }

    const mask = masked ? socket.buffer.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(socket.buffer.subarray(offset + maskOffset, total));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    socket.buffer = socket.buffer.subarray(total);
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
  }

  return messages;
}

function leaveRoom(socket) {
  if (!socket.roomId) return;
  const room = rooms.get(socket.roomId);
  if (!room) return;
  room.clients.delete(socket);
  for (const client of room.clients) {
    sendFrame(client, JSON.stringify({ type: "peer-left" }));
  }
  if (room.clients.size === 0) rooms.delete(socket.roomId);
}

function joinRoom(socket, roomId, requestedRole) {
  leaveRoom(socket);
  const cleanRoom = String(roomId || "handball").slice(0, 32);
  let room = rooms.get(cleanRoom);
  if (!room) {
    room = { clients: new Set(), host: null };
    rooms.set(cleanRoom, room);
  }

  const role = requestedRole === "host" && !room.host ? "host" : room.host ? "guest" : "host";
  socket.roomId = cleanRoom;
  socket.role = role;
  room.clients.add(socket);
  if (role === "host") room.host = socket;

  sendFrame(socket, JSON.stringify({ type: "joined", room: cleanRoom, role }));
  for (const client of room.clients) {
    if (client !== socket) sendFrame(client, JSON.stringify({ type: "peer-joined", role }));
  }
}

function relay(socket, message) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    return;
  }

  if (data.type === "join") {
    joinRoom(socket, data.room, data.role);
    return;
  }

  const room = rooms.get(socket.roomId);
  if (!room) return;
  const wire = JSON.stringify(data);
  for (const client of room.clients) {
    if (client !== socket) sendFrame(client, wire);
  }
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const filePath = path.join(__dirname, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade !== "websocket") {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  socket.on("data", (chunk) => {
    for (const message of readFrames(socket, chunk)) relay(socket, message);
  });
  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

server.listen(PORT, () => {
  console.log(`NY Handball Rally serving at http://localhost:${PORT}`);
});
