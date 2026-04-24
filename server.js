const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? genCode() : code;
}

function roomInfo(room) {
  return { players: room.players, settings: room.settings, state: room.state, viewerCount: room.viewers.size + 1 };
}

io.on('connection', socket => {
  let currentRoom = null;
  let isHost = false;

  socket.on('create-room', cb => {
    if (currentRoom) leaveRoom();
    const code = genCode();
    rooms.set(code, {
      host: socket.id,
      players: [],
      settings: {},
      viewers: new Set(),
      state: 'waiting',
    });
    currentRoom = code;
    isHost = true;
    socket.join(code);
    cb({ code });
  });

  socket.on('join-room', (code, cb) => {
    if (currentRoom) leaveRoom();
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { cb({ error: 'Room not found' }); return; }
    currentRoom = code;
    isHost = false;
    room.viewers.add(socket.id);
    socket.join(code);
    cb({ ok: true, ...roomInfo(room) });
    io.to(code).emit('viewer-count', room.viewers.size + 1);
  });

  socket.on('update-players', players => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.players = players;
      socket.to(currentRoom).emit('players-updated', players);
    }
  });

  socket.on('update-settings', settings => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.settings = settings;
      socket.to(currentRoom).emit('settings-updated', settings);
    }
  });

  socket.on('race-countdown', () => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.state = 'countdown';
      socket.to(currentRoom).emit('race-countdown');
    }
  });

  socket.on('race-start', data => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.state = 'racing';
      socket.to(currentRoom).emit('race-started', data);
    }
  });

  socket.on('race-update', data => {
    if (!isHost || !currentRoom) return;
    socket.to(currentRoom).emit('race-frame', data);
  });

  socket.on('race-end', data => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.state = 'results';
      room.lastResults = data;
      socket.to(currentRoom).emit('race-ended', data);
    }
  });

  socket.on('back-to-setup', () => {
    if (!isHost || !currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.state = 'waiting';
      socket.to(currentRoom).emit('back-to-setup');
    }
  });

  function leaveRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) { currentRoom = null; return; }
    if (isHost) {
      io.to(currentRoom).emit('host-left');
      rooms.delete(currentRoom);
    } else {
      room.viewers.delete(socket.id);
      socket.to(currentRoom).emit('viewer-count', room.viewers.size + 1);
    }
    socket.leave(currentRoom);
    currentRoom = null;
    isHost = false;
  }

  socket.on('leave-room', () => leaveRoom());
  socket.on('disconnect', () => leaveRoom());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Football Race running on port ${PORT}`));
