const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = 'Yvs0920';
const MESSAGE_FILE = path.join(__dirname, 'messages.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(MESSAGE_FILE)) fs.writeFileSync(MESSAGE_FILE, '[]', 'utf8');

app.use(express.static('public'));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path.basename(file.originalname || 'file', ext).replace(/[^\w\-]+/g, '_');
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const upload = multer({ storage });

function readMessages() {
  try {
    return JSON.parse(fs.readFileSync(MESSAGE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveMessages(messages) {
  fs.writeFileSync(MESSAGE_FILE, JSON.stringify(messages, null, 2), 'utf8');
}

function addMessage(message) {
  const messages = readMessages();
  messages.push(message);
  saveMessages(messages);
}

function updateMessage(messageId, updater) {
  const messages = readMessages();
  const index = messages.findIndex(m => m.id === messageId);
  if (index === -1) return null;
  updater(messages[index]);
  saveMessages(messages);
  return messages[index];
}

function recallMessage(messageId, username) {
  const messages = readMessages();
  const target = messages.find(m => m.id === messageId);

  if (!target) return { ok: false, reason: '消息不存在' };
  if (target.username !== username) return { ok: false, reason: '只能撤回自己的消息' };
  if (target.recalled) return { ok: false, reason: '这条消息已经撤回' };

  if (Date.now() - target.timestamp > 60 * 1000) {
    return { ok: false, reason: '超过1分钟不能撤回' };
  }

  target.recalled = true;
  target.type = 'text';
  target.text = '这条消息已被撤回';
  target.imageUrl = '';
  target.videoUrl = '';
  target.audioUrl = '';
  target.fileUrl = '';
  target.fileName = '';

  saveMessages(messages);
  return { ok: true, message: target };
}

app.post('/upload', upload.single('file'), (req, res) => {
  const { code, username, avatarUrl = '' } = req.body;

  if (code !== ACCESS_CODE) {
    return res.status(403).json({ error: '无效进入码' });
  }

  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const mime = req.file.mimetype || '';
  const filePath = `/uploads/${req.file.filename}`;
  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');

  const message = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    username: username || '匿名',
    avatarUrl,
    timestamp: Date.now(),
    type: isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file',
    text: '',
    imageUrl: isImage ? filePath : '',
    videoUrl: isVideo ? filePath : '',
    audioUrl: isAudio ? filePath : '',
    fileUrl: filePath,
    fileName: req.file.originalname || '文件',
    recalled: false,
    readBy: [username || '匿名']
  };

  addMessage(message);
  io.emit('chat message', message);
  res.json({ success: true, message });
});

io.on('connection', socket => {
  socket.on('join', ({ code, username, avatarUrl = '' }) => {
    if (code !== ACCESS_CODE) {
      socket.emit('access-denied');
      return;
    }

    socket.data.username = username || '匿名';
    socket.data.avatarUrl = avatarUrl || '';

    socket.emit('access-granted', {
      username: socket.data.username,
      avatarUrl: socket.data.avatarUrl
    });

    socket.emit('chat history', readMessages());

    socket.broadcast.emit('system message', {
      text: `${socket.data.username} 进入了聊天`,
      timestamp: Date.now()
    });
  });

  socket.on('chat message', payload => {
    if (!socket.data.username) return;

    const text = typeof payload === 'string' ? payload : (payload.text || '');
    const avatarUrl = typeof payload === 'object' ? (payload.avatarUrl || socket.data.avatarUrl || '') : (socket.data.avatarUrl || '');

    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      username: socket.data.username,
      avatarUrl,
      timestamp: Date.now(),
      type: 'text',
      text,
      imageUrl: '',
      videoUrl: '',
      audioUrl: '',
      fileUrl: '',
      fileName: '',
      recalled: false,
      readBy: [socket.data.username]
    };

    addMessage(message);
    io.emit('chat message', message);
  });

  socket.on('mark-read', ({ messageId, username }) => {
    if (!messageId || !username) return;

    const updated = updateMessage(messageId, msg => {
      if (!msg.readBy) msg.readBy = [];
      if (!msg.readBy.includes(username)) msg.readBy.push(username);
    });

    if (updated) {
      io.emit('read-update', {
        messageId: updated.id,
        readBy: updated.readBy || []
      });
    }
  });

  socket.on('recall-message', ({ messageId }) => {
    if (!socket.data.username) return;

    const result = recallMessage(messageId, socket.data.username);

    if (!result.ok) {
      socket.emit('recall-failed', { reason: result.reason });
      return;
    }

    io.emit('message-recalled', { message: result.message });
  });

  socket.on('disconnect', () => {
    if (socket.data.username) {
      socket.broadcast.emit('system message', {
        text: `${socket.data.username} 离开了聊天`,
        timestamp: Date.now()
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Enigma running on port ${PORT}`);
});

