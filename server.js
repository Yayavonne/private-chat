const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ACCESS_CODE = "Yvs0920";
const MESSAGE_FILE = path.join(__dirname, 'messages.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(MESSAGE_FILE)) {
  fs.writeFileSync(MESSAGE_FILE, '[]', 'utf8');
}

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeBase = path.basename(file.originalname, ext).replace(/[^\w\-]+/g, '_');
    const name = `${Date.now()}-${safeBase}${ext}`;
    cb(null, name);
  }
});

const upload = multer({ storage });

function readMessages() {
  try {
    const raw = fs.readFileSync(MESSAGE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
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

function markRead(messageId, username) {
  const messages = readMessages();
  const target = messages.find(m => m.id === messageId);
  if (!target) return null;

  if (!target.readBy) target.readBy = [];
  if (!target.readBy.includes(username)) {
    target.readBy.push(username);
  }

  saveMessages(messages);
  return target;
}

app.post('/upload', upload.single('file'), (req, res) => {
  const { code, username } = req.body;

  if (code !== ACCESS_CODE) {
    return res.status(403).json({ error: 'Invalid access code' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const mime = req.file.mimetype || '';
  const isImage = mime.startsWith('image/');

  const message = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    type: isImage ? 'image' : 'file',
    imageUrl: isImage ? `/uploads/${req.file.filename}` : '',
    fileUrl: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    username: username || 'Anonymous',
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now(),
    readBy: [username || 'Anonymous']
  };

  addMessage(message);
  io.emit('chat message', message);

  res.json({ success: true, message });
});

io.on('connection', (socket) => {
  socket.on('join', ({ code, username }) => {
    if (code !== ACCESS_CODE) {
      socket.emit('access-denied');
      return;
    }

    socket.data.username = username || 'Anonymous';
    socket.data.joined = true;

    socket.emit('access-granted', { username: socket.data.username });

    const messages = readMessages();
    socket.emit('chat history', messages);

    socket.broadcast.emit('system message', {
      text: `${socket.data.username} joined the chat`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('chat message', (text) => {
    if (!socket.data.joined) return;

    const message = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type: 'text',
      text,
      username: socket.data.username || 'Anonymous',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now(),
      readBy: [socket.data.username || 'Anonymous']
    };

    addMessage(message);
    io.emit('chat message', message);
  });

  socket.on('mark-read', ({ messageId }) => {
    if (!socket.data.username || !messageId) return;

    const updated = markRead(messageId, socket.data.username);
    if (updated) {
      io.emit('read-update', {
        messageId: updated.id,
        readBy: updated.readBy
      });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.username) {
      socket.broadcast.emit('system message', {
        text: `${socket.data.username} left the chat`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
  });
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});


