'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

class GatewayConn extends EventEmitter {
  constructor(url, token, id) {
    super();
    this.url = url;
    this.token = token || '';
    this.id = id;
    this.ws = null;
    this.status = 'offline';
    this.sessions = [];
    this._reqId = 0;
    this._activeRuns = new Map(); // sessionKey -> { runId, status }
    this._pending = new Map();
    this._reconnectTimer = null;
    this._destroyed = false;
    this._lastSeq = null;
    this.agentEmojis = { main: '🧠', search: '🔍', dev: '💻', monitor: '📡', quant: '📈' };
    this._connectNonce = null;
    this._connectSent = false;
    this._cachedModels = [];
  }

  connect() {
    if (this._destroyed) return;
    this._setStatus('connecting');
    this._clearReconnect();
    this._connectSent = false;
    this._lastSeq = null;

    try {
      this.ws = new WebSocket(this.url, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        origin: 'http://localhost',
      });
    } catch (err) {
      console.error(`[GW ${this.id}] create error:`, err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log(`[GW ${this.id}] connected`);
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleMessage(msg);
      } catch (err) {
        console.error(`[GW ${this.id}] parse error:`, err.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[GW ${this.id}] closed: ${code} ${reason}`);
      this._setStatus('offline');
      this._flushPending('connection closed');
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[GW ${this.id}] error:`, err.message);
    });
  }

  disconnect() {
    this._destroyed = true;
    this._clearReconnect();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._setStatus('offline');
  }

  // ---- 握手 ----
  _sendConnect(nonce) {
    if (this._connectSent) return;
    this._connectSent = true;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        version: 'panel',
        platform: 'linux',
        mode: 'ui',
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      caps: ['tool-events'],
    };

    if (this.token) {
      params.auth = { token: this.token };
    }

    this._request('connect', params).then((res) => {
      console.log(`[GW ${this.id}] connected OK`);
      this._setStatus('online');
      this.listSessions();
    }).catch((err) => {
      console.error(`[GW ${this.id}] connect failed:`, err.message);
      // Still try to list sessions in case of partial auth
      this._setStatus('online');
      this.listSessions();
    });
  }

  // ---- Run status tracking ----
  _setRunStatus(sessionKey, status, runId) {
    const active = this._activeRuns.get(sessionKey);
    
    if (status === 'started' || status === 'running') {
      // New run or activity — start/continue tracking
      if (!active || (runId && active.runId !== runId)) {
        // New run detected (different runId or no previous run)
        this._activeRuns.set(sessionKey, { runId: runId || null, status });
        this.emit('run-status', sessionKey, status);
      } else if (status === 'running' && active.status !== 'running') {
        // Same run, update status
        active.status = status;
        this.emit('run-status', sessionKey, status);
      }
    } else if (status === 'completed' || status === 'error' || status === 'idle') {
      // End of run — only emit if we were tracking this run
      if (active) {
        // If runId provided, only complete if it matches the active run
        if (!runId || !active.runId || active.runId === runId) {
          this._activeRuns.delete(sessionKey);
          this.emit('run-status', sessionKey, status);
        }
        // else: stale event from old run, ignore
      }
    }
  }

  // ---- 消息处理 ----
  _handleMessage(msg) {
    // Event messages
    if (msg.type === 'event') {
      this._handleEvent(msg);
      return;
    }

    // Response messages
    if (msg.type === 'res') {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.payload ?? msg.data ?? msg.result ?? null);
        } else {
          pending.reject(new Error(msg.error?.message || 'request failed'));
        }
      }
      return;
    }
  }

  _handleEvent(msg) {
    const event = msg.event || msg.type;
    const payload = msg.payload || msg.data || {};
    // Log non-trivial events
    if (event && !['heartbeat','tick','presence','health','connect.ok','connect.challenge'].includes(event)) {
      console.log(`[GW ${this.id}] ← event: ${event}`, JSON.stringify(payload).substring(0, 200));
    }

    // Sequence tracking
    const seq = typeof msg.seq === 'number' ? msg.seq : null;
    if (seq !== null && this._lastSeq !== null && seq > this._lastSeq + 1) {
      console.warn(`[GW ${this.id}] gap: expected ${this._lastSeq + 1}, got ${seq}`);
    }
    if (seq !== null) this._lastSeq = seq;

    switch (event) {
      case 'connect.challenge': {
        const nonce = payload?.nonce || null;
        if (nonce) this._connectNonce = nonce;
        this._sendConnect(nonce);
        break;
      }

      case 'chat':
      case 'chat.completion':
      case 'chat.completion.chunk': {
        // Skip streaming deltas — only broadcast final/completed messages to avoid duplicates
        const state = payload.state || msg.state;
        if (state === 'delta' || state === 'streaming') break;
        const sessionKey = payload.sessionKey || payload.session_key || 'main';
        const message = payload.message || payload;
        this.emit('message', sessionKey, this._normalizeMessage(message));
        // Mark run as completed when final message arrives (only if matching active run)
        if (state === 'final' || !state) {
          this._setRunStatus(sessionKey, 'completed', payload.runId);
        }
        // Update session cache
        const sess = this.sessions.find(s => s.key === sessionKey);
        if (sess) {
          const raw = message?.content || message?.text || payload?.text || '';
          if (typeof raw === 'string') sess.lastPreview = raw.substring(0, 80);
          else if (Array.isArray(raw)) {
            const tp = raw.find(p => p.type === 'text');
            sess.lastPreview = tp ? tp.text.substring(0, 80) : `[${raw[0]?.type || '...'}]`;
          }
          sess.lastActivity = Date.now();
          sess.messageCount = (sess.messageCount || 0) + 1;
          this.emit('sessions', this.sessions);
        }
        break;
      }

      case 'session.message': {
        const sessionKey = payload.sessionKey || 'main';
        const message = payload.message || payload;
        this.emit('message', sessionKey, this._normalizeMessage(message));
        break;
      }

      case 'agent': {
        // Agent stream events — track by runId to avoid stale status
        const phase = payload.phase || payload.data?.phase;
        const stream = payload.stream;
        const sessionKey = payload.sessionKey || 'main';
        const runId = payload.runId;

        if (stream === 'lifecycle' && phase === 'start') {
          this._setRunStatus(sessionKey, 'started', runId);
        } else if (stream === 'lifecycle' && phase === 'end') {
          this._setRunStatus(sessionKey, 'completed', runId);
          this.listSessions();
        } else if (phase === 'end' || phase === 'error') {
          this._setRunStatus(sessionKey, phase === 'end' ? 'completed' : 'error', runId);
          this.listSessions();
        } else if (phase === 'start') {
          this._setRunStatus(sessionKey, 'started', runId);
        } else if (stream === 'thinking') {
          this._setRunStatus(sessionKey, 'thinking', runId);
        } else if (stream === 'tool_call' || stream === 'tool' || stream === 'tool_use') {
          this._setRunStatus(sessionKey, 'tool', runId);
        } else if (stream === 'assistant') {
          this._setRunStatus(sessionKey, 'writing', runId);
        } else if (stream === 'tool_result') {
          // After tool result, model is thinking again
          this._setRunStatus(sessionKey, 'thinking', runId);
        }
        break;
      }

      case 'sessions.changed': {
        // Refresh sessions list on any change
        this.listSessions();
        break;
      }

      case 'exec.approval.requested': {
        // Forward approval request to Panel UI
        const approvalId = payload.id || msg.id;
        const request = payload.request || payload;
        console.log(`[GW ${this.id}] exec.approval.requested id=${approvalId} cmd="${(request.command||'').substring(0,80)}"`);
        this.emit('exec-approval', {
          id: approvalId,
          command: request.command || '',
          argv: request.systemRunBinding?.argv || [],
          cwd: request.systemRunBinding?.cwd || null,
          agentId: request.systemRunBinding?.agentId || 'main',
          sessionKey: request.systemRunBinding?.sessionKey || '',
        });
        break;
      }

      case 'exec.approval.resolved': {
        const approvalId = payload.id || msg.id;
        const decision = payload.decision || 'deny';
        console.log(`[GW ${this.id}] exec.approval.resolved id=${approvalId} decision=${decision}`);
        this.emit('exec-approval-resolved', { id: approvalId, decision });
        break;
      }

      case 'presence':
      case 'tick':
      case 'health':
        // Ignore system events
        break;

      default:
        // Unknown events — ignore silently
        break;
    }
  }

  // ---- API 方法 ----
  async listSessions() {
    try {
      const res = await this._request('sessions.list', {});
      console.log(`[GW ${this.id}] sessions.list raw:`, JSON.stringify(res).substring(0, 500));
      const list = res?.sessions || res?.data || (Array.isArray(res) ? res : []);
      this.sessions = list.map(s => this._normalizeSession(s));
      // Extract default model from sessions.list response
      if (res?.defaults?.modelProvider && res?.defaults?.model) {
        this._defaultModel = res.defaults.modelProvider + '/' + res.defaults.model;
      }
      this.emit('sessions', this.sessions);
    } catch (err) {
      console.error(`[GW ${this.id}] listSessions error:`, err.message);
    }
  }

  async loadHistory(sessionKey) {
    try {
      const res = await this._request('chat.history', { sessionKey, limit: 200 });
      const raw = JSON.stringify(res);
      console.log(`[GW ${this.id}] chat.history raw (${sessionKey}):`, raw.substring(0, 300));
      const messages = (res?.messages || res?.data || (Array.isArray(res) ? res : [])).map(m => this._normalizeMessage(m));
      this.emit('history', sessionKey, messages);
    } catch (err) {
      console.error(`[GW ${this.id}] loadHistory error:`, err.message);
    }
  }

  async sendMessage(sessionKey, text, attachments) {
    try {
      console.log(`[GW ${this.id}] sendMessage INPUT: text="${(text||'').substring(0,60)}", atts=${attachments?.length||0}`);
      let messageText = text || '';
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (att.localPath) {
            // Include file path in message text so agent can analyze it
            messageText += (messageText ? '\n' : '') + `📎 已上传文件: ${att.localPath} (${att.filename}, ${att.mimetype})`;
          } else if (att.base64) {
            // Legacy base64 path (kept for compatibility)
            messageText += (messageText ? '\n' : '') + `[附件: ${att.filename} (${att.mimetype})]`;
          }
        }
      }
      const body = {
        sessionKey,
        message: messageText,
        idempotencyKey: Date.now() + ':' + (++this._reqId),
      };
      console.log(`[GW ${this.id}] chat.send →`, JSON.stringify(body).substring(0, 500));
      const resp = await this._request('chat.send', body);
      console.log(`[GW ${this.id}] chat.send ←`, JSON.stringify(resp).substring(0, 300));
    } catch (err) {
      console.error(`[GW ${this.id}] sendMessage error:`, err.message, err.stack?.split('\n').slice(0,3).join('\n'));
    }
  }

  async injectMessage(sessionKey, text) {
    try {
      const body = { sessionKey, message: text };
      console.log(`[GW ${this.id}] chat.inject →`, JSON.stringify(body).substring(0, 300));
      const resp = await this._request('chat.inject', body);
      console.log(`[GW ${this.id}] chat.inject ←`, JSON.stringify(resp).substring(0, 300));
    } catch (err) {
      console.error(`[GW ${this.id}] injectMessage error:`, err.message, err.stack?.split('\n').slice(0,3).join('\n'));
    }
  }

  async createSession(agentId, label) {
    try {
      await this._request('sessions.create', { agentId, label });
      setTimeout(() => this.listSessions(), 500);
    } catch (err) {
      console.error(`[GW ${this.id}] createSession error:`, err.message);
    }
  }

  async deleteSession(sessionKey) {
    try {
      console.log(`[GW ${this.id}] deleteSession → key=${sessionKey}`);
      await this._request('sessions.delete', { key: sessionKey });
      console.log(`[GW ${this.id}] deleteSession ← ok`);
      this.sessions = this.sessions.filter(s => s.key !== sessionKey);
      this.emit('sessions', this.sessions);
    } catch (err) {
      console.error(`[GW ${this.id}] deleteSession error:`, err.message);
    }
  }

  async renameSession(sessionKey, name) {
    try {
      console.log(`[GW ${this.id}] renameSession → key=${sessionKey}, label=${name}`);
      const resp = await this._request('sessions.patch', { key: sessionKey, label: name });
      console.log(`[GW ${this.id}] renameSession ←`, JSON.stringify(resp).substring(0, 200));
      const sess = this.sessions.find(s => s.key === sessionKey);
      if (sess) { sess.name = name; this.emit('sessions', this.sessions); }
    } catch (err) {
      console.error(`[GW ${this.id}] renameSession error:`, err.message);
    }
  }

  async abort(sessionKey) {
    try {
      await this._request('chat.abort', { sessionKey });
    } catch (err) {
      console.error(`[GW ${this.id}] abort error:`, err.message);
    }
  }

  async resolveApproval(approvalId, decision) {
    try {
      console.log(`[GW ${this.id}] resolveApproval id=${approvalId} decision=${decision}`);
      await this._request('exec.approval.resolve', { id: approvalId, decision });
    } catch (err) {
      console.error(`[GW ${this.id}] resolveApproval error:`, err.message);
    }
  }

  async getModels() {
    const models = [];
    const seen = new Set();

    // 1. Try gateway config.get to extract provider models
    try {
      const config = await this._request('config.get', {});
      if (config) {
        const providers = config.providers || {};
        for (const [provName, prov] of Object.entries(providers)) {
          const modelList = prov.models || prov.model || [];
          const arr = Array.isArray(modelList) ? modelList : [modelList];
          for (const m of arr) {
            const id = typeof m === 'string' ? m : (m.id || m.name || m.model || '');
            if (id && !seen.has(id)) {
              seen.add(id);
              models.push({ id: provName + '/' + id, provider: provName, name: id });
            }
          }
        }
      }
    } catch (err) {
      console.log(`[GW ${this.id}] config.get not available`);
    }

    // 2. Add defaults from sessions.list (modelProvider + model)
    if (this._defaultModel && !seen.has(this._defaultModel)) {
      seen.add(this._defaultModel);
      const short = this._defaultModel.split('/').pop();
      models.push({ id: this._defaultModel, provider: this._defaultModel.split('/')[0], name: short });
    }

    // 3. Merge models discovered from message history
    for (const m of (this._cachedModels || [])) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        models.push(m);
      }
    }

    // 4. Known common models as fallback (openrouter free tier)
    const fallbacks = [
      { id: 'openrouter/xiaomi/mimo-v2-pro', provider: 'openrouter', name: 'mimo-v2-pro' },
      { id: 'openrouter/google/gemma-3-12b', provider: 'openrouter', name: 'gemma-3-12b' },
      { id: 'openrouter/meta-llama/llama-3.3-70b-instruct', provider: 'openrouter', name: 'llama-3.3-70b' },
      { id: 'openrouter/deepseek/deepseek-r1', provider: 'openrouter', name: 'deepseek-r1' },
      { id: 'openrouter/deepseek/deepseek-chat-v3', provider: 'openrouter', name: 'deepseek-chat-v3' },
      { id: 'openrouter/google/gemini-2.0-flash-001', provider: 'openrouter', name: 'gemini-2.0-flash' },
      { id: 'openrouter/google/gemini-2.5-pro-preview', provider: 'openrouter', name: 'gemini-2.5-pro' },
      { id: 'openrouter/anthropic/claude-sonnet-4', provider: 'openrouter', name: 'claude-sonnet-4' },
      { id: 'openrouter/qwen/qwen3-235b-a22b', provider: 'openrouter', name: 'qwen3-235b' },
      { id: 'zhipu/glm-4.7-flash', provider: 'zhipu', name: 'glm-4.7-flash' },
    ];
    for (const m of fallbacks) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        models.push(m);
      }
    }

    this._cachedModels = models;
    return models;
  }

  collectModelsFromMessages(messages) {
    const seen = new Set(this._cachedModels?.map(m => m.id) || []);
    const models = [...(this._cachedModels || [])];
    for (const msg of (messages || [])) {
      if (msg.model && !seen.has(msg.model)) {
        seen.add(msg.model);
        const short = msg.model.split('/').pop();
        models.push({ id: msg.model, provider: msg.model.split('/')[0], name: short });
      }
    }
    this._cachedModels = models;
    return models;
  }

  // ---- WS 通信 ----
  _request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('gateway not connected'));
      }
      const id = String(++this._reqId);
      const payload = { type: 'req', id, method, params };
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('request timeout'));
      }, 15000);
      this._pending.set(id, {
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  // ---- 标准化 ----
  _normalizeSession(s) {
    var name = s.displayName || s.name || s.label || s.title || '';
    var key = s.key || s.sessionKey || s.id || '';
    var dn = s.displayName || '';

    // If name looks like an internal identifier, try to make a friendly one
    if (!name || name.startsWith('webchat:') || name.startsWith('agent:') || name.startsWith('ou_')) {
      // ---- g-agent-{agent}-subagent-UUID patterns ----
      // Match: g-agent-main-subagent-UUID, g-agent-search-subagent-UUID, etc.
      var subagentMatch = key.match(/^g-agent-(\w+)-subagent-(.+)$/);
      if (!subagentMatch && dn) subagentMatch = dn.match(/g-agent-(\w+)-subagent-(.+)/);
      if (subagentMatch) {
        var agentId = subagentMatch[1];
        var uuid = subagentMatch[2];
        var agentEmoji = this.agentEmojis[agentId] || '🤖';
        // Use last 6 chars of UUID for unique identification
        name = agentEmoji + ' ' + agentId + ' 子会话 #' + uuid.slice(-6);
      }
      // ---- dashboard session: agent:{id}:dashboard ----
      else if (/^agent:\w+:dashboard/.test(key)) {
        var dashAgent = key.split(':')[1] || 'main';
        var dashEmoji = this.agentEmojis[dashAgent] || '🤖';
        name = dashEmoji + ' ' + dashAgent + ' 面板';
      }
      // ---- main session: agent:{id}:main ----
      else if (/^agent:\w+:main$/.test(key)) {
        var mainAgent = key.split(':')[1] || 'main';
        var mainEmoji = this.agentEmojis[mainAgent] || '🤖';
        name = mainEmoji + ' ' + mainAgent + ' 主会话';
      }
      // ---- feishu / user sessions ----
      else if (key.indexOf('feishu') >= 0 || key.indexOf('ou_') >= 0 || dn.startsWith('ou_')) {
        var id = key.match(/ou_[a-f0-9]+/);
        name = '飞书用户: ' + (id ? id[0].slice(-8) : key.slice(-8));
      }
      // ---- cron sessions ----
      else if (key.startsWith('agent:main:cron:')) {
        name = s.displayName || '定时任务';
      }
      // ---- webchat sessions ----
      else if (dn.startsWith('webchat:ou_')) {
        name = '用户: ' + dn.replace('webchat:ou_', '').slice(-6);
      }
      else if (dn.startsWith('webchat:')) {
        name = dn.replace('webchat:', '').substring(0, 20);
      }
      // ---- fallback: extract a meaningful part of the key ----
      else if (!name) {
        // Try to parse key like agent:{id}:{type}:{uuid}
        var parts = key.split(':');
        if (parts.length >= 3) {
          var ag = parts[1];
          var typ = parts[2];
          var agEmoji = this.agentEmojis[ag] || '';
          if (typ === 'cron') name = '⏰ 定时任务';
          else if (parts.length > 3) name = (agEmoji ? agEmoji + ' ' : '') + ag + ' · ' + typ + ' #' + parts[parts.length-1].slice(-6);
          else name = (agEmoji ? agEmoji + ' ' : '') + ag + ' · ' + typ;
        } else {
          name = key.substring(0, 24) || 'Unknown';
        }
      }
    }

    // Parse agent from key pattern: agent:{agentId}:...
    var agentFromKey = '';
    if (key.indexOf('agent:') === 0) {
      var _parts = key.split(':');
      if (_parts.length >= 2) agentFromKey = _parts[1];
    }

    // Also check g-agent-{id}-subagent pattern for agent extraction
    if (!agentFromKey) {
      var gaMatch = key.match(/^g-agent-(\w+)-subagent/);
      if (gaMatch) agentFromKey = gaMatch[1];
    }

    return {
      key: key,
      name: name,
      kind: s.kind || 'direct',
      chatType: s.chatType || s.chat_type || 'direct',
      agent: s.agent || s.agentId || agentFromKey || 'main',
      messages: [],
      messageCount: s.messageCount || s.messages || 0,
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      totalTokens: s.totalTokens || 0,
      lastActivity: s.updatedAt || s.updated_at || s.lastActivity || null,
      lastPreview: s.lastPreview || s.preview || '',
      sessionId: s.sessionId || null,
    };
  }

  _normalizeMessage(m) {
    const msg = {
      role: m.role || m.sender || 'assistant',
      content: m.content || m.text || '',
      ts: m.ts || m.timestamp || m.createdAt || m.created_at || Date.now(),
      model: m.model || m.api?.model || '',
      usage: m.usage || null,
    };
    if (typeof msg.content === 'string' && msg.content.startsWith('[')) {
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) msg.content = parsed;
      } catch {}
    }
    return msg;
  }

  // ---- 工具 ----
  _setStatus(status) {
    if (this.status !== status) {
      this.status = status;
      this.emit('status', status);
    }
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    this._clearReconnect();
    const delay = 2000 + Math.random() * 3000;
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _flushPending(reason) {
    for (const [, { reject }] of this._pending) {
      reject(new Error(reason));
    }
    this._pending.clear();
  }

  _formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}

module.exports = GatewayConn;
