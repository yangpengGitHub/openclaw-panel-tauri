'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const GatewayConn = require('./lib/gateway');
const multer = require('multer');

// ===== Config =====
const CONFIG_PATH = path.join(__dirname, 'config.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { instances: [], port: 19800 }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Default agents
const DEFAULT_AGENTS = [
  { id: 'main',    name: 'Main',    emoji: '🧠', color: '#6366f1' },
  { id: 'search',  name: 'Search',  emoji: '🔍', color: '#10b981' },
  { id: 'dev',     name: 'Dev',     emoji: '💻', color: '#f59e0b' },
  { id: 'monitor', name: 'Monitor', emoji: '📡', color: '#3b82f6' },
  { id: 'quant',   name: 'Quant',   emoji: '📈', color: '#ef4444' },
];

function getAgents(cfg) {
  if (!cfg.agents) {
    cfg.agents = JSON.parse(JSON.stringify(DEFAULT_AGENTS));
    saveConfig(cfg);
  }
  return cfg.agents;
}

// Ensure all default agents exist (called on boot to add any missing defaults)
function ensureDefaultAgents(cfg) {
  if (!cfg.agents) cfg.agents = [];
  const existing = new Set(cfg.agents.map(a => a.id));
  let changed = false;
  for (const def of DEFAULT_AGENTS) {
    if (!existing.has(def.id)) {
      cfg.agents.push(JSON.parse(JSON.stringify(def)));
      changed = true;
    }
  }
  if (changed) saveConfig(cfg);
}

function saveAgents(cfg, agents) {
  cfg.agents = agents;
  saveConfig(cfg);
}

function buildAgentEmojiMap(agents) {
  const map = {};
  agents.forEach(a => { map[a.id] = a.emoji; });
  return map;
}

// ===== Upload =====
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// ===== Express =====
const app = express();
app.use(express.json());

// Disable caching in dev
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false, maxAge: 0, cacheControl: false
}));

// Media proxy from openclaw media dir
app.use('/media', express.static('/home/pi/.openclaw/media'));

// Uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    filename: req.file.originalname,
    savedAs: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    url: `/uploads/${req.file.filename}`,
    path: path.join(UPLOAD_DIR, req.file.filename)
  });
});

// P1: File download endpoint - serves files from allowed directories
app.get('/api/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

  // Security: resolve and validate the path
  const ALLOWED_BASES = [
    path.resolve('/home/pi/.openclaw/'),
    path.resolve('/home/pi/.openclaw/workspace/'),
    path.resolve(__dirname),
    path.resolve(__dirname, 'uploads'),
    path.resolve('/tmp/openclaw/'),
  ];

  let resolved;
  if (path.isAbsolute(filePath)) {
    resolved = path.resolve(filePath);
  } else {
    // Try resolving against workspace first, then panel directory
    const wsResolved = path.resolve('/home/pi/.openclaw/workspace/', filePath);
    const panelResolved = path.resolve(__dirname, filePath);
    if (fs.existsSync(wsResolved)) {
      resolved = wsResolved;
    } else if (fs.existsSync(panelResolved)) {
      resolved = panelResolved;
    } else {
      resolved = wsResolved; // Default to workspace for permission check
    }
  }

  // Check if the resolved path is within an allowed base
  const isAllowed = ALLOWED_BASES.some(base => resolved.startsWith(base));
  if (!isAllowed) {
    console.log(`[Panel] Download denied: ${resolved}`);
    return res.status(403).json({ error: 'Access denied' });
  }

  // Check file exists
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileName = path.basename(resolved);
  console.log(`[Panel] Download: ${resolved}`);
  // Use stream approach for Express 5 compatibility
  try {
    const stat = fs.statSync(resolved);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(resolved);
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error(`[Panel] Download stream error:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
    });
  } catch (err) {
    console.error(`[Panel] Download error:`, err.message);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Get available models for an instance
app.get('/api/models/:instanceId', async (req, res) => {
  const gw = panel?.gateways?.get(req.params.instanceId);
  if (!gw || gw.status !== 'online') return res.json({ models: [] });
  try {
    let models = await gw.getModels();
    res.json({ models });
  } catch (err) {
    res.json({ models: gw._cachedModels || [] });
  }
});

// ===== Server + WS =====
const server = http.createServer(app);

// ===== Panel Manager =====
class PanelManager {
  constructor() {
    this.gateways = new Map();       // id -> GatewayConn
    this.browsers = new Set();       // Set<ws>
    this.config = loadConfig();
    ensureDefaultAgents(this.config);
    this.userMsgCache = new Map();   // "instId/sessionKey" -> [{role:'user', content, ts, _uploads}]
    this._recentMsgs = new Map();    // "instId/sessionKey" -> [{role, textHash, ts}] for dedup
    this._runStatus = new Map();     // "instId/sessionKey" -> 'running'|'completed'|'idle'
    this._initGateways();
  }

  _initGateways() {
    this._syncAgentEmojis();
    for (const inst of this.config.instances) {
      this._addGateway(inst);
    }
  }

  _addGateway(inst) {
    const gw = new GatewayConn(inst.url, inst.token, inst.id);
    this.gateways.set(inst.id, gw);

    gw.on('status', (status) => {
      // Clear stale run statuses on reconnect
      if (status === 'online') {
        for (const [key] of this._runStatus) {
          if (key.startsWith(inst.id + '/')) {
            this._runStatus.delete(key);
            this._broadcast({ type: 'run-status', instanceId: inst.id, sessionKey: key.split('/')[1], status: 'idle' });
          }
        }
      }
      this._broadcast({ type: 'instance-status', id: inst.id, status });
    });

    gw.on('sessions', (sessions) => {
      const pinned = inst.pinnedSessions || [];
      const pinnedSet = new Set(pinned);
      const enriched = sessions.map(s => ({
        key: s.key, name: s.name || s.key, kind: s.kind, chatType: s.chatType,
        agent: s.agent, messageCount: s.messageCount || 0,
        inputTokens: s.inputTokens || 0, outputTokens: s.outputTokens || 0,
        totalTokens: s.totalTokens || 0,
        lastActivity: s.lastActivity, lastPreview: s.lastPreview || '',
        runStatus: this._runStatus.get(`${inst.id}/${s.key}`) || 'idle',
        pinned: pinnedSet.has(s.key),
      }));
      const sorted = enriched
        .filter(s => pinnedSet.has(s.key))
        .sort((a, b) => pinned.indexOf(a.key) - pinned.indexOf(b.key))
        .concat(
          enriched
            .filter(s => !pinnedSet.has(s.key))
            .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
        );
      this._broadcast({ type: 'sessions', instanceId: inst.id, sessions: sorted });
    });

    gw.on('message', (sessionKey, message) => {
      const cacheKey = `${inst.id}/${sessionKey}`;
      // Server-side dedup: skip if same role+content seen in last 60s
      if (!this._recentMsgs.has(cacheKey)) this._recentMsgs.set(cacheKey, []);
      const recent = this._recentMsgs.get(cacheKey);
      function _mt(c) { if (typeof c === 'string') return c; if (Array.isArray(c)) return c.filter(p => p.type === 'text').map(p => p.text || '').join(''); return ''; }
      const newText = _mt(message.content);
      const now = Date.now();
      const isDup = recent.some(r => r.role === message.role && r.text === newText && (now - r.ts) < 60000);
      if (isDup) { console.log(`[Panel] dedup skip → ${inst.id}/${sessionKey}`); return; }
      recent.push({ role: message.role, text: newText, ts: now });
      // Keep only last 10
      if (recent.length > 10) recent.splice(0, recent.length - 10);
      console.log(`[Panel] msg → ${inst.id}/${sessionKey}`);
      this._broadcast({ type: 'message', instanceId: inst.id, sessionKey, message });
      // Collect model from message for dropdown
      if (message.model) gw.collectModelsFromMessages([message]);
    });

    gw.on('history', (sessionKey, messages) => {
      // Merge user messages (cached locally) with Gateway agent messages
      const cacheKey = `${inst.id}/${sessionKey}`;
      const userMsgs = this.userMsgCache.get(cacheKey) || [];
      const merged = [...userMsgs, ...messages].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      
      // Deduplicate: Gateway history may also contain user messages from cache
      // Compare by normalized text content for same-role consecutive messages
      function _toText(c) {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.filter(p => p.type === 'text').map(p => p.text || '').join('');
        return '';
      }
      const deduped = [];
      for (const m of merged) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.role === 'user' && m.role === 'user' && _toText(prev.content) === _toText(m.content)) {
          // Keep the Gateway version (has more metadata), skip cache duplicate
          // But if prev is from cache (no model), replace it
          if (!prev.model && m.model) { deduped[deduped.length - 1] = m; }
          continue;
        }
        deduped.push(m);
      }
      
      this._broadcast({ type: 'history', instanceId: inst.id, sessionKey, messages: deduped });
      // Collect models from history for dropdown
      gw.collectModelsFromMessages(deduped);
    });

    gw.on('run-status', (sessionKey, status) => {
      const key = `${inst.id}/${sessionKey}`;
      this._runStatus.set(key, status);
      this._broadcast({ type: 'run-status', instanceId: inst.id, sessionKey, status });
    });

    gw.on('exec-approval', (approval) => {
      console.log(`[Panel] exec.approval.requested from GW ${inst.id}: ${approval.command.substring(0, 60)}`);
      this._broadcast({ type: 'exec-approval', instanceId: inst.id, approval });
    });

    gw.on('exec-approval-resolved', (data) => {
      this._broadcast({ type: 'exec-approval-resolved', instanceId: inst.id, ...data });
    });

    gw.connect();
  }

  _removeGateway(id) {
    const gw = this.gateways.get(id);
    if (gw) { gw.disconnect(); this.gateways.delete(id); }
  }

  _syncAgentEmojis() {
    const agents = getAgents(this.config);
    const emojiMap = buildAgentEmojiMap(agents);
    for (const [, gw] of this.gateways) {
      gw.agentEmojis = emojiMap;
    }
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.browsers) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  // Auto-name session based on first user message
  // Only renames sessions that still have internal-looking names
  _autoNameSession(instanceId, sessionKey, text) {
    if (!text || typeof text !== 'string') return;
    // Check if session name looks like an internal identifier
    const gw = this.gateways.get(instanceId);
    if (!gw) return;
    const sess = gw.sessions?.find(s => s.key === sessionKey);
    if (!sess) return;
    const name = sess.name || '';
    // Only auto-rename if the name looks internal
    const isInternal = !name ||
      name.startsWith('g-agent-') ||
      name.startsWith('agent:') ||
      /^[🧠🔍💻📡📈🤖] \w+ 子会话 #/.test(name) ||  // our generated subagent names
      /^[🧠🔍💻📡📈🤖] \w+ · subagent #/.test(name) || // fallback subagent format
      /^[🧠🔍💻📡📈🤖] \w+ 面板$/.test(name) ||     // our generated dashboard names
      name === 'Unknown';
    if (!isInternal) return;
    // Skip if already auto-named (track in a set)
    const nameKey = `${instanceId}/${sessionKey}`;
    if (!this._autoNamedSessions) this._autoNamedSessions = new Set();
    if (this._autoNamedSessions.has(nameKey)) return;
    this._autoNamedSessions.add(nameKey);
    // Generate a short summary from the first message
    let summary = text.replace(/[\n\r]/g, ' ').trim();
    // Remove common prefixes
    summary = summary.replace(/^(请|帮我|帮|做一下|测试一下|看一下|查一下|写一下|run|test|check|do|make)\s*/i, '');
    // Truncate to ~20 chars (Chinese-friendly)
    if (summary.length > 20) summary = summary.substring(0, 20) + '…';
    // Prefix with agent emoji
    const agents = getAgents(this.config);
    const emojiMap = buildAgentEmojiMap(agents);
    const agentEmoji = emojiMap[sess.agent] || '💬';
    const newName = agentEmoji + ' ' + summary;
    console.log(`[Panel] auto-name session: ${sessionKey} → "${newName}"`);
    gw.renameSession(sessionKey, newName);
  }

  _fullState() {
    return {
      type: 'full-state',
      ts: Date.now(),
      agents: getAgents(this.config),
      instances: this.config.instances.map(inst => {
        const gw = this.gateways.get(inst.id);
        const rawSessions = gw?.sessions || [];
        if (rawSessions.length > 0) {
          console.log(`[Panel] _fullState ${inst.id} sessions:`, rawSessions.map(s => ({ key: s.key, name: s.name })));
        }
        const pinned = inst.pinnedSessions || [];
        const sessions = rawSessions.map(s => ({
          key: s.key, name: s.name || s.key, kind: s.kind, chatType: s.chatType,
          agent: s.agent, messageCount: s.messageCount || 0,
          inputTokens: s.inputTokens || 0, outputTokens: s.outputTokens || 0,
          totalTokens: s.totalTokens || 0,
          lastActivity: s.lastActivity, lastPreview: s.lastPreview || '',
          runStatus: this._runStatus.get(`${inst.id}/${s.key}`) || 'idle',
          pinned: pinned.includes(s.key),
        }));
        // Sort: pinned first (in pin order), then unpinned by lastActivity desc
        const pinnedSet = new Set(pinned);
        const sorted = sessions
          .filter(s => pinnedSet.has(s.key))
          .sort((a, b) => pinned.indexOf(a.key) - pinned.indexOf(b.key))
          .concat(
            sessions
              .filter(s => !pinnedSet.has(s.key))
              .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
          );
        return {
          ...inst,
          status: gw?.status || 'offline',
          sessions: sorted,
        };
      })
    };
  }

  _broadcastFullState() {
    this._broadcast(this._fullState());
  }

  addBrowser(ws) {
    this.browsers.add(ws);
    ws.send(JSON.stringify(this._fullState()));
  }

  removeBrowser(ws) {
    this.browsers.delete(ws);
  }

  handleBrowserMessage(ws, msg) {
    switch (msg.type) {
      case 'add-instance': {
        const inst = {
          id: `gw-${Date.now()}`,
          name: msg.name,
          url: msg.url,
          token: msg.token || '',
          desc: msg.desc || '',
          color: msg.color || randomColor()
        };
        this.config.instances.push(inst);
        saveConfig(this.config);
        this._addGateway(inst);
        this._broadcast({ type: 'instance-added', instance: { ...inst, status: 'connecting' } });
        break;
      }

      case 'remove-instance': {
        const id = msg.instanceId;
        this.config.instances = this.config.instances.filter(i => i.id !== id);
        saveConfig(this.config);
        this._removeGateway(id);
        this._broadcast({ type: 'instance-removed', id });
        break;
      }

      case 'refresh-sessions': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.listSessions();
        break;
      }

      case 'load-history': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.loadHistory(msg.sessionKey);
        break;
      }

      case 'send-message': {
        console.log(`[Panel] send-message: text="${(msg.text||'').substring(0,60)}", atts=${msg.attachments?.length||0}`);
        if (msg.attachments) console.log(`[Panel] att[0].localPath=${msg.attachments[0]?.localPath}`);
        const gw = this.gateways.get(msg.instanceId);
        if (gw) {
          // Cache user message locally (Gateway history doesn't include user messages)
          const cacheKey = `${msg.instanceId}/${msg.sessionKey}`;
          if (!this.userMsgCache.has(cacheKey)) this.userMsgCache.set(cacheKey, []);
          const userMsg = {
            role: 'user',
            content: msg.text || '',
            ts: Date.now(),
            _uploads: msg.attachments || null,
          };
          this.userMsgCache.get(cacheKey).push(userMsg);
          // Broadcast user message to all browsers immediately
          this._broadcast({ type: 'message', instanceId: msg.instanceId, sessionKey: msg.sessionKey, message: userMsg });
          gw.sendMessage(msg.sessionKey, msg.text, msg.attachments);

          // Auto-name session: if session name still looks like an internal ID, rename it
          // using the first user message summary
          this._autoNameSession(msg.instanceId, msg.sessionKey, msg.text);
        }
        break;
      }

      case 'inject-message': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.injectMessage(msg.sessionKey, msg.text);
        break;
      }

      case 'delete-session': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.deleteSession(msg.sessionKey);
        break;
      }

      case 'rename-session': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.renameSession(msg.sessionKey, msg.name);
        break;
      }

      case 'create-session': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.createSession(msg.agentId, msg.label);
        break;
      }

      case 'rename-instance': {
        const id = msg.instanceId;
        const inst = this.config.instances.find(i => i.id === id);
        if (inst) {
          if (msg.name) inst.name = msg.name;
          if (msg.desc !== undefined) inst.description = msg.desc;
          if (msg.color) inst.color = msg.color;
          saveConfig(this.config);
          this._broadcast({ type: 'instance-renamed', id, name: inst.name, desc: inst.description, color: inst.color });
        }
        break;
      }

      case 'abort': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.abort(msg.sessionKey);
        break;
      }

      case 'resolve-approval': {
        const gw = this.gateways.get(msg.instanceId);
        if (gw) gw.resolveApproval(msg.approvalId, msg.decision);
        break;
      }

      case 'pin-session': {
        const id = msg.instanceId;
        const inst = this.config.instances.find(i => i.id === id);
        if (inst) {
          if (!inst.pinnedSessions) inst.pinnedSessions = [];
          if (!inst.pinnedSessions.includes(msg.sessionKey)) {
            inst.pinnedSessions.push(msg.sessionKey);
            saveConfig(this.config);
          }
          this._broadcastFullState();
        }
        break;
      }

      case 'unpin-session': {
        const id = msg.instanceId;
        const inst = this.config.instances.find(i => i.id === id);
        if (inst && inst.pinnedSessions) {
          inst.pinnedSessions = inst.pinnedSessions.filter(k => k !== msg.sessionKey);
          saveConfig(this.config);
          this._broadcastFullState();
        }
        break;
      }

      // ===== Agent CRUD =====
      case 'add-agent': {
        const agents = getAgents(this.config);
        if (agents.find(a => a.id === msg.id)) {
          ws.send(JSON.stringify({ type: 'error', message: `Agent "${msg.id}" 已存在` }));
          break;
        }
        agents.push({ id: msg.id, name: msg.name || msg.id, emoji: msg.emoji || '💬', color: msg.color || '#6b7280' });
        saveAgents(this.config, agents);
        this._syncAgentEmojis();
        this._broadcast({ type: 'agents-updated', agents });
        console.log(`[Panel] Agent added: ${msg.id}`);
        break;
      }

      case 'update-agent': {
        const agents = getAgents(this.config);
        const idx = agents.findIndex(a => a.id === msg.id);
        if (idx === -1) {
          ws.send(JSON.stringify({ type: 'error', message: `Agent "${msg.id}" 不存在` }));
          break;
        }
        if (msg.name) agents[idx].name = msg.name;
        if (msg.emoji) agents[idx].emoji = msg.emoji;
        if (msg.color) agents[idx].color = msg.color;
        // Allow id change (rename) with newId
        if (msg.newId && msg.newId !== msg.id) {
          if (agents.find(a => a.id === msg.newId)) {
            ws.send(JSON.stringify({ type: 'error', message: `Agent ID "${msg.newId}" 已存在` }));
            break;
          }
          agents[idx].id = msg.newId;
        }
        saveAgents(this.config, agents);
        this._syncAgentEmojis();
        this._broadcast({ type: 'agents-updated', agents });
        console.log(`[Panel] Agent updated: ${msg.id}`);
        break;
      }

      case 'remove-agent': {
        let agents = getAgents(this.config);
        if (agents.length <= 1) {
          ws.send(JSON.stringify({ type: 'error', message: '至少保留一个 Agent' }));
          break;
        }
        agents = agents.filter(a => a.id !== msg.id);
        saveAgents(this.config, agents);
        this._syncAgentEmojis();
        this._broadcast({ type: 'agents-updated', agents });
        console.log(`[Panel] Agent removed: ${msg.id}`);
        break;
      }

      case 'reorder-agents': {
        const agents = getAgents(this.config);
        const byId = {};
        agents.forEach(a => { byId[a.id] = a; });
        const reordered = (msg.order || []).map(id => byId[id]).filter(Boolean);
        // Append any missing agents
        agents.forEach(a => { if (!reordered.find(r => r.id === a.id)) reordered.push(a); });
        saveAgents(this.config, reordered);
        this._broadcast({ type: 'agents-updated', agents: reordered });
        break;
      }

      case 'get-agents': {
        ws.send(JSON.stringify({ type: 'agents-updated', agents: getAgents(this.config) }));
        break;
      }
    }
  }
}

const panel = new PanelManager();

// ===== Panel WebSocket =====
const wss = new WebSocketServer({ server, path: '/panel-ws' });

wss.on('connection', (ws) => {
  panel.addBrowser(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type !== 'full-state') console.log('[Panel] Browser →', msg.type, JSON.stringify(msg).substring(0, 200));
      panel.handleBrowserMessage(ws, msg);
    } catch (err) {
      console.error('[Panel] Invalid message:', err.message);
    }
  });

  ws.on('close', () => panel.removeBrowser(ws));
});

// ===== Helper =====
function randomColor() {
  const colors = ['#818cf8','#f472b6','#34d399','#fbbf24','#60a5fa','#a78bfa','#fb923c','#2dd4bf'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ===== Start =====
const PORT = process.env.PORT || panel.config.port || 19800;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Panel] Listening on http://0.0.0.0:${PORT}`);
});
