// OpenClaw Panel - Main Application

// ===== PWA Service Worker =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(function(reg) {
    // Listen for notification clicks from SW
    navigator.serviceWorker.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'notification-click') {
        selectInstance(e.data.instanceId);
        setTimeout(function() { selectSession(e.data.sessionKey); }, 300);
      }
    });
  }).catch(function(){});
}

// ===== Browser Notifications =====
var _notifPermission = 'default';
function initNotifications() {
  if (!('Notification' in window)) return;
  _notifPermission = Notification.permission;
  if (_notifPermission === 'default') {
    // Show subtle prompt after a delay
    setTimeout(function() {
      var n = document.createElement('div');
      n.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:#fff;border:1px solid var(--border);border-radius:12px;padding:10px 16px;font-size:13px;z-index:9000;box-shadow:0 4px 20px rgba(0,0,0,.12);display:flex;align-items:center;gap:10px;max-width:90vw;cursor:pointer';
      n.innerHTML = '🔔 任务完成时通知你 <span style="color:var(--accent);font-weight:500;white-space:nowrap">开启</span> <span style="color:var(--dim);cursor:pointer" onclick="event.stopPropagation();this.parentElement.remove()">✕</span>';
      n.onclick = function() {
        Notification.requestPermission().then(function(p) {
          _notifPermission = p;
          if (p === 'granted') toast('通知已开启', 'success');
          n.remove();
        });
      };
      document.body.appendChild(n);
      // Auto-dismiss after 15s
      setTimeout(function() { if (n.parentNode) n.remove(); }, 15000);
    }, 3000);
  }
}
initNotifications();

function sendNotification(title, body, data) {
  if (_notifPermission !== 'granted') return;
  // Don't notify if tab is focused
  if (!document.hidden) return;
  var opts = {
    body: body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'oc-' + (data && data.sessionKey || 'default'),
    renotify: true,
    data: data || {},
    vibrate: [100, 50, 100]
  };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'show-notification',
      title: title,
      options: opts
    });
    // Fallback: use SW registration directly
    navigator.serviceWorker.ready.then(function(reg) {
      reg.showNotification(title, opts);
    });
  } else {
    new Notification(title, opts);
  }
}

// ===== Virtual Keyboard Handling (Mobile) =====
(function() {
  if (!('visualViewport' in window)) return;
  var vv = window.visualViewport;
  function onResize() {
    // Adjust input area position when keyboard appears
    var inputArea = document.getElementById('input-area');
    if (inputArea && vv.height < window.innerHeight * 0.6) {
      // Keyboard is open
      document.body.style.height = vv.height + 'px';
      inputArea.style.position = 'fixed';
      inputArea.style.bottom = (window.innerHeight - vv.height - vv.offsetTop) + 'px';
    } else {
      document.body.style.height = '';
      var ia = document.getElementById('input-area');
      if (ia) { ia.style.position = ''; ia.style.bottom = ''; }
    }
  }
  vv.addEventListener('resize', onResize);
  vv.addEventListener('scroll', onResize);
})();

// ===== PWA Install Prompt =====
var _deferredPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  _deferredPrompt = e;
  // Show subtle install hint
  var hint = document.createElement('div');
  hint.id = 'pwa-install-hint';
  hint.style.cssText = 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);background:#6366f1;color:#fff;padding:8px 16px;border-radius:20px;font-size:12px;cursor:pointer;z-index:9000;box-shadow:0 2px 12px rgba(99,102,241,.3);animation:fadeIn .3s';
  hint.textContent = '📲 安装到桌面';
  hint.onclick = function() {
    _deferredPrompt.prompt();
    _deferredPrompt.userChoice.then(function(choice) {
      _deferredPrompt = null;
      hint.remove();
    });
  };
  document.body.appendChild(hint);
  // Auto-hide after 10s
  setTimeout(function() { if (hint.parentNode) hint.remove(); }, 10000);
});

// ===== Prevent double-tap zoom on mobile =====
document.addEventListener('touchend', function(e) {
  var now = Date.now();
  if (now - (document._lastTouchEnd || 0) < 300) e.preventDefault();
  document._lastTouchEnd = now;
}, { passive: false });

const instances = [];
let activeInstanceId = null;
let activeSessionKey = null;
let activeAgentId = 'main';
let ctxTarget = null;
let panelWs = null;
let wsReconnectTimer = null;
let attachments = [];
const unreadSessions = new Map(); // Map<"instanceId/sessionKey", number> — unread message count per session (single source of truth)
const filters = { thinking: true, tools: true }; // true = shown (pressed), matching native UI default
let _renderedMsgCount = 0; // track incremental render state
let _renderDebounceTimer = null; // debounce full re-renders
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// ===== Agent Definitions =====
let AGENT_DEFS = [
  { id: 'main',    name: 'Main',    emoji: '🧠', color: '#6366f1' },
  { id: 'search',  name: 'Search',  emoji: '🔍', color: '#10b981' },
  { id: 'dev',     name: 'Dev',     emoji: '💻', color: '#f59e0b' },
  { id: 'monitor', name: 'Monitor', emoji: '📡', color: '#3b82f6' },
  { id: 'quant',   name: 'Quant',   emoji: '📈', color: '#ef4444' },
];

function getAgentDef(id) {
  return AGENT_DEFS.find(function(a){return a.id===id}) || { id: id, name: id, emoji: '💬', color: '#6b7280' };
}

// Get all sessions across all instances that belong to a specific agent
function getSessionsForAgent(agentId) {
  var result = [];
  instances.forEach(function(inst) {
    (inst.sessions || []).forEach(function(s) {
      if ((s.agent || 'main') === agentId) {
        result.push({ instanceId: inst.id, instanceName: inst.name, session: s });
      }
    });
  });
  return result;
}

// Get agent IDs that have sessions
function getActiveAgentIds() {
  var ids = {};
  instances.forEach(function(inst) {
    (inst.sessions || []).forEach(function(s) {
      ids[s.agent || 'main'] = true;
    });
  });
  return ids;
}

// Slash commands
const COMMANDS = [
  // 核心
  { name: '/help', desc: '显示帮助信息', icon: '❓' },
  { name: '/commands', desc: '列出所有命令', icon: '📋' },
  { name: '/status', desc: '查看状态', icon: '📊' },
  { name: '/whoami', desc: '查看发送者 ID', icon: '🪪' },
  // 会话
  { name: '/new', desc: '新建会话', icon: '✨' },
  { name: '/reset', desc: '重置当前会话', icon: '🔄' },
  { name: '/clear', desc: '清空当前会话', icon: '🗑️' },
  { name: '/session', desc: '查看会话信息', icon: '💬' },
  { name: '/context', desc: '上下文详情', icon: '📐' },
  { name: '/export', desc: '导出会话为 HTML', icon: '📤' },
  // 模型 & 推理
  { name: '/model', desc: '切换模型', icon: '🤖' },
  { name: '/reasoning', desc: '切换推理模式', icon: '🧠' },
  { name: '/think', desc: '设置思考深度', icon: '💭' },
  { name: '/fast', desc: '快速模式', icon: '⚡' },
  // 输出
  { name: '/verbose', desc: '切换详细输出', icon: '📝' },
  { name: '/usage', desc: '用量/费用统计', icon: '💰' },
  { name: '/tools', desc: '查看可用工具', icon: '🔧' },
  // 子代理
  { name: '/subagents', desc: '管理子代理', icon: '👥' },
  { name: '/kill', desc: '终止子代理', icon: '💀' },
  { name: '/steer', desc: '引导子代理', icon: '🎯' },
  { name: '/btw', desc: '侧问（不影响上下文）', icon: '🤫' },
  // 控制
  { name: '/stop', desc: '停止当前任务', icon: '🛑' },
  { name: '/restart', desc: '重启 Gateway', icon: '🔁' },
  { name: '/compact', desc: '压缩上下文', icon: '📦' },
  // TTS
  { name: '/tts', desc: '文字转语音控制', icon: '🔊' },
  // 技能
  { name: '/skill', desc: '运行技能', icon: '⚡' },
];
let cmdIndex = -1;
let cmdFiltered = [];

// ===== Server URL Configuration (for Tauri Android) =====
// On Android/Tauri, the app loads from bundled assets (tauri://localhost).
// We need a configurable server URL for WebSocket and API calls.
const _isTauri = typeof window.__TAURI__ !== 'undefined' || typeof window.__TAURI_PLUGIN_SHELL__ !== 'undefined';
const _isTauriAndroid = _isTauri && /android/i.test(navigator.userAgent);

function getServerUrl() {
  if (_isTauriAndroid) {
    return localStorage.getItem('oc-server-url') || '';
  }
  return location.origin;
}

function getWsUrl() {
  var serverUrl = getServerUrl();
  if (!serverUrl) return '';
  var proto = serverUrl.startsWith('https') ? 'wss:' : 'ws:';
  return proto + '//' + serverUrl.replace(/^https?:\/\//, '');
}

function resolveUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) {
    var base = getServerUrl();
    return base ? base + url : url;
  }
  return url;
}

// ===== Panel WS =====
function connectPanel() {
  if (panelWs && panelWs.readyState <= 1) return;
  var wsUrl = getWsUrl();
  if (!wsUrl) {
    // No server URL configured - show setup dialog
    showServerSetup();
    return;
  }
  panelWs = new WebSocket(wsUrl + '/panel-ws');
  panelWs.onopen = () => console.log('[Panel] WS connected');
  panelWs.onmessage = (e) => { try { handlePanelMessage(JSON.parse(e.data)); } catch(err) { console.error(err); } };
  panelWs.onclose = () => { clearTimeout(wsReconnectTimer); wsReconnectTimer = setTimeout(connectPanel, 2000); };
  panelWs.onerror = (err) => console.error('[Panel] WS error:', err);
}

function send(type, data) {
  if (panelWs && panelWs.readyState === 1) panelWs.send(JSON.stringify(Object.assign({type}, data || {})));
}

// ===== Panel Message Handler =====
function handlePanelMessage(msg) {
  switch (msg.type) {
    case 'full-state':
      // Preserve existing sessions/messages when updating from full-state
      var oldInstMap = {};
      instances.forEach(function(inst){
        oldInstMap[inst.id] = {};
        (inst.sessions||[]).forEach(function(s){ oldInstMap[inst.id][s.key] = s; });
      });
      instances.length = 0;
      for (var fi=0; fi<msg.instances.length; fi++) {
        var inst_f = msg.instances[fi];
        var oldSessMap = oldInstMap[inst_f.id] || {};
        // Clear stale runStatus if instance is connected
        var isConnected = (inst_f.status || 'offline') === 'online';
        instances.push({
          id: inst_f.id, name: inst_f.name, url: inst_f.url, token: inst_f.token,
          desc: inst_f.desc || '', color: inst_f.color || '#818cf8',
          status: inst_f.status || 'offline',
          sessions: (inst_f.sessions || []).map(function(s){
            var old = oldSessMap[s.key];
            return {
              key: s.key, name: s.name || s.key, agent: s.agent || 'main',
              messages: old ? old.messages : [],
              messageCount: s.messageCount || 0,
              lastActivity: s.lastActivity, lastPreview: s.lastPreview || '',
              runStatus: isConnected ? 'idle' : (s.runStatus || 'idle'),
              pinned: s.pinned || false,
            };
          })
        });
      }
      renderInstances();
      renderSessions();
      if (instances.length && !activeInstanceId) selectInstance(instances[0].id);
      // Load agents from server config
      if (msg.agents && msg.agents.length) AGENT_DEFS = msg.agents;
      renderAgents();
      break;
    case 'instance-status':
      var inst = instances.find(function(i){return i.id===msg.id});
      if (inst) {
        inst.status = msg.status;
        // Clear stale runStatus when gateway reconnects
        if (msg.status === 'online') {
          (inst.sessions||[]).forEach(function(s){ s.runStatus = 'idle'; });
          if (msg.id === activeInstanceId) {
            var ts=document.getElementById('task-status');
            var ti=document.getElementById('task-status-icon');
            var tt=document.getElementById('task-status-text');
            var ab=document.getElementById('abort-btn');
            if(ab) ab.classList.remove('running');
            if(ts){ts.className='task-status done';if(ti)ti.textContent='✓';if(tt)tt.textContent='就绪';}
          }
        }
        renderInstances();
        if (msg.id===activeInstanceId) renderSessions();
      }
      break;
    case 'instance-added':
      if (!instances.find(function(i){return i.id===msg.instance.id})) {
        instances.push(Object.assign(msg.instance, {status: msg.instance.status||'connecting', sessions:[]}));
        renderInstances();
      }
      break;
    case 'instance-removed':
      var idx = instances.findIndex(function(i){return i.id===msg.id});
      if (idx>=0) { instances.splice(idx,1); if (activeInstanceId===msg.id){activeInstanceId=null;activeSessionKey=null;renderSessions();renderMessages();} renderInstances(); }
      break;
    case 'instance-renamed':
      var inst = instances.find(function(i){return i.id===msg.id});
      if (inst) { if(msg.name) inst.name=msg.name; if(msg.desc!==undefined) inst.desc=msg.desc; if(msg.color) inst.color=msg.color; renderAgents(); renderSessions(); }
      break;
    case 'sessions':
      var inst = instances.find(function(i){return i.id===msg.instanceId});
      if (inst) {
        var oldKeys = {}; inst.sessions.forEach(function(s){oldKeys[s.key]=true;});
        var em = {}; inst.sessions.forEach(function(s){em[s.key]=s;});
        inst.sessions = (msg.sessions||[]).map(function(s){var ex=em[s.key];return {key:s.key,name:s.name||s.key,agent:s.agent||'main',messages:ex?ex.messages:[],messageCount:s.messageCount||0,lastActivity:s.lastActivity,lastPreview:s.lastPreview||'',runStatus:ex?ex.runStatus:'idle',pinned:ex?ex.pinned:false};});
        renderAgents(); renderSessions();
        // Auto-select newly created session
        var pending = window._pendingNewSession;
        if (pending && pending.instanceId === msg.instanceId) {
          var newSess = inst.sessions.find(function(s){return !oldKeys[s.key]});
          if (newSess) {
            selectSession(msg.instanceId, newSess.key);
            // If delegated, send the text automatically
            if (pending.delegateText) {
              var inp = document.getElementById('msg-input');
              if (inp) {
                inp.value = pending.delegateText;
                setTimeout(function(){ sendMessage(); }, 300);
              }
            }
            window._pendingNewSession = null;
            // Focus input
            var inp = document.getElementById('msg-input');
            if (inp) inp.focus();
          }
        }
      }
      break;
    case 'message':
      var inst = instances.find(function(i){return i.id===msg.instanceId});
      if (inst) {
        var sess = inst.sessions.find(function(s){return s.key===msg.sessionKey});
        if (sess) {
          if (!sess.messages) sess.messages = [];
          // Dedup: skip if same role+content already exists in recent messages
          function _toText(c) {
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.filter(function(p){return p.type==='text'}).map(function(p){return p.text||''}).join('');
            return '';
          }
          var incoming = msg.message;
          if (incoming) {
            var incomingText = _toText(incoming.content);
            var isDup = false;
            var checkCount = Math.min(3, sess.messages.length);
            for (var di = 1; di <= checkCount; di++) {
              var prev = sess.messages[sess.messages.length - di];
              if (prev && prev.role === incoming.role && _toText(prev.content) === incomingText) {
                // Update existing message with server data (model, usage, full content)
                if (incoming.model) prev.model = incoming.model;
                if (incoming.usage) prev.usage = incoming.usage;
                if (incoming.content) prev.content = incoming.content;
                isDup = true;
                break;
              }
            }
            if (isDup) {
              if (msg.instanceId===activeInstanceId&&msg.sessionKey===activeSessionKey) { renderMessagesDebounced(); }
              else { markUnread(msg.instanceId, msg.sessionKey); }
              break;
            }
          }
          sess.messages.push(msg.message);
          var raw = msg.message.content||msg.message.text||'';
          if (typeof raw==='string') sess.lastPreview=raw.substring(0,80);
          else if (Array.isArray(raw)){var tp=raw.find(function(p){return p.type==='text'});sess.lastPreview=tp?tp.text.substring(0,80):'['+((raw[0]&&raw[0].type)||'...')+']';}
          sess.lastActivity = msg.message.ts||Date.now();
          if (msg.instanceId===activeInstanceId&&msg.sessionKey===activeSessionKey){renderMessagesAppend();}
          else { markUnread(msg.instanceId, msg.sessionKey); }
          renderSessions();
        }
      }
      break;
    case 'history':
      var inst = instances.find(function(i){return i.id===msg.instanceId});
      if (inst) {
        var sess = inst.sessions.find(function(s){return s.key===msg.sessionKey});
        if (sess) { sess.messages = msg.messages||[]; _renderedMsgCount=0; if (msg.instanceId===activeInstanceId&&msg.sessionKey===activeSessionKey){renderMessagesDebounced();setTimeout(scrollToBottom,200);} }
      }
      break;
    case 'run-status':
      // Update session's runStatus in memory (for all sessions)
      var rsInst = instances.find(function(i){return i.id===msg.instanceId});
      if (rsInst) {
        var rsSess = rsInst.sessions.find(function(s){return s.key===msg.sessionKey});
        if (rsSess) rsSess.runStatus = msg.status;
      }
      // Notify for completed/error on ANY session (not just active)
      if (msg.status==='completed'||msg.status==='idle'||msg.status==='error') {
        var _rsInst = rsInst;
        var _rsSess = _rsInst ? _rsInst.sessions.find(function(s){return s.key===msg.sessionKey}) : null;
        var _sessName = _rsSess ? (_rsSess.name || msg.sessionKey) : msg.sessionKey;
        var _instName = _rsInst ? (_rsInst.name || msg.instanceId) : msg.instanceId;
        var _isOther = (msg.instanceId !== activeInstanceId || msg.sessionKey !== activeSessionKey);
        if (msg.status==='error') {
          sendNotification('❌ ' + _sessName, '任务出错', {sessionKey: msg.sessionKey, instanceId: msg.instanceId});
          if (_isOther) { toast(_instName + ' · ' + _sessName + ' 出错了', 'error'); markUnread(msg.instanceId, msg.sessionKey); }
        } else {
          sendNotification('✅ ' + _sessName, _instName + ' · 回复完成', {sessionKey: msg.sessionKey, instanceId: msg.instanceId});
          if (_isOther) { toast(_instName + ' · ' + _sessName + ' 回复完成', 'success'); markUnread(msg.instanceId, msg.sessionKey); }
        }
      }
      // Only update DOM for the active session
      if (msg.instanceId !== activeInstanceId || msg.sessionKey !== activeSessionKey) break;
      var btn = document.getElementById('abort-btn');
      var ts = document.getElementById('task-status');
      var ti = document.getElementById('task-status-icon');
      var tt = document.getElementById('task-status-text');
      // Auto-reset timeout: if no new running event for 15s, go idle
      if (window._runStatusTimer) clearTimeout(window._runStatusTimer);
      if (msg.status==='started'||msg.status==='thinking'||msg.status==='writing'||msg.status==='tool'||msg.status==='running') {
        btn.classList.add('running');
        if(ts){
          ts.className='task-status running';
          if(ti){
            if(msg.status==='thinking') ti.textContent='💭';
            else if(msg.status==='tool') ti.textContent='🔧';
            else if(msg.status==='writing') ti.textContent='✍️';
            else ti.textContent='⏳';
          }
          if(tt){
            if(msg.status==='thinking') tt.textContent='思考中...';
            else if(msg.status==='tool') tt.textContent='调用工具中...';
            else if(msg.status==='writing') tt.textContent='正在回复...';
            else tt.textContent='思考中...';
          }
        }
        window._runStatusTimer = setTimeout(function(){
          btn.classList.remove('running');
          if(ts){ts.className='task-status done';if(ti)ti.textContent='✓';if(tt)tt.textContent='完成';}
          var tsi=instances.find(function(i){return i.id===activeInstanceId});
          if(tsi){var tss=tsi.sessions.find(function(s){return s.key===activeSessionKey});if(tss)tss.runStatus='idle';}
        }, 15000);
      } else if (msg.status==='completed'||msg.status==='idle') {
        btn.classList.remove('running');
        if(ts){ts.className='task-status done';if(ti)ti.textContent='✓';if(tt)tt.textContent='完成';}
        setTimeout(function(){if(ts)ts.style.display='none';},2000);
      } else if (msg.status==='error') {
        btn.classList.remove('running');
        if(ts){ts.className='task-status';if(ti)ti.textContent='❌';if(tt)tt.textContent='出错了';}
      } else {
        btn.classList.remove('running');
        if(ts){ts.style.display='none';}
      }
      break;

    case 'exec-approval':
      showApprovalDialog(msg.instanceId, msg.approval);
      break;

    case 'exec-approval-resolved':
      hideApprovalDialog(msg.id);
      break;

    case 'agents-updated':
      AGENT_DEFS = msg.agents || AGENT_DEFS;
      renderAgents();
      if (typeof renderAgentManagerModal === 'function') renderAgentManagerModal();
      break;
  }
}

// ===== Instance Management =====
function addInstance() {
  var name=document.getElementById('m-name').value.trim();
  var url=document.getElementById('m-url').value.trim();
  var token=document.getElementById('m-token').value.trim();
  var desc=document.getElementById('m-desc').value.trim();
  if (!name||!url) return alert('名称和地址必填');
  send('add-instance',{name:name,url:url,token:token,desc:desc});
  closeAddModal();
}

function selectAgent(agentId) {
  activeAgentId = agentId;
  // Auto-select first instance if not selected
  if (!activeInstanceId && instances.length) {
    activeInstanceId = instances[0].id;
  }
  var agent = getAgentDef(agentId);
  document.getElementById('panel-title').textContent = agent.emoji + ' ' + agent.name;
  var descEl = document.getElementById('gateway-desc');
  if (descEl) {
    var inst = instances.find(function(i){return i.id===activeInstanceId});
    descEl.textContent = (inst && inst.status === 'online') ? '' : (inst ? (inst.status === 'connecting' ? '连接中...' : '离线') : '未连接');
  }
  activeSessionKey = null;
  renderAgents();
  renderSessions();
  renderMessages();
  var ss = document.getElementById('session-search'); if(ss) ss.style.display = 'block';
  document.getElementById('session-panel').classList.remove('open');
  // Auto-select first session for this agent
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  if (inst && inst.sessions) {
    var agentSessions = inst.sessions.filter(function(s){return (s.agent||'main')===agentId;});
    if (agentSessions.length > 0) {
      selectSession(activeInstanceId, agentSessions[0].key);
    }
  }
}

function selectInstance(id) {
  activeInstanceId = id; activeSessionKey = null; clearUnread(id);
  renderAgents(); renderSessions(); renderMessages();
  var inst = instances.find(function(i){return i.id===id});
  // Update gateway description
  var descEl = document.getElementById('gateway-desc');
  if (descEl) {
    descEl.textContent = inst ? (inst.status === 'online' ? '' : (inst.status === 'connecting' ? '连接中...' : '离线')) : '';
  }
  var ss = document.getElementById('session-search'); if(ss) ss.style.display = 'block';
  document.getElementById('session-panel').classList.remove('open');
  // Re-select current agent for this instance
  selectAgent(activeAgentId);
}

function selectSession(instanceId, sessionKey) {
  activeInstanceId=instanceId; activeSessionKey=sessionKey;
  _renderedMsgCount=0; // reset incremental render state
  // Clear all unread for this instance
  clearUnread(instanceId);
  var inst=instances.find(function(i){return i.id===instanceId});
  var sess=inst?inst.sessions.find(function(s){return s.key===sessionKey}):null;
  // Update active agent based on session
  if (sess) activeAgentId = sess.agent || 'main';
  renderAgents(); renderSessions();
  var ch=document.getElementById('chat-header'); if(ch) ch.style.display='flex';
  document.getElementById('ch-name').textContent=sess?sess.name:sessionKey;
  var chAgent=document.getElementById('ch-agent');
  if(chAgent) {
    var adef = getAgentDef(sess ? (sess.agent||'main') : activeAgentId);
    chAgent.textContent=adef.emoji+' '+adef.name;
    chAgent.style.display='';
  }
  // Restore run-status from session data
  var btn=document.getElementById('abort-btn');
  var ts=document.getElementById('task-status');
  var ti=document.getElementById('task-status-icon');
  var tt=document.getElementById('task-status-text');
  if(ts) ts.style.display=''; // reset any previous auto-hide
  if (sess && (sess.runStatus === 'thinking' || sess.runStatus === 'writing' || sess.runStatus === 'tool' || sess.runStatus === 'running' || sess.runStatus === 'started')) {
    if(btn) btn.classList.add('running');
    if(ts){
      ts.className='task-status running';
      if(ti){
        if(sess.runStatus==='thinking') ti.textContent='💭';
        else if(sess.runStatus==='tool') ti.textContent='🔧';
        else if(sess.runStatus==='writing') ti.textContent='✍️';
        else ti.textContent='⏳';
      }
      if(tt){
        if(sess.runStatus==='thinking') tt.textContent='思考中...';
        else if(sess.runStatus==='tool') tt.textContent='调用工具中...';
        else if(sess.runStatus==='writing') tt.textContent='正在回复...';
        else tt.textContent='思考中...';
      }
    }
  } else if (sess && sess.runStatus === 'error') {
    if(btn) btn.classList.remove('running');
    if(ts){ts.className='task-status';if(ti)ti.textContent='❌';if(tt)tt.textContent='出错了';}
  } else {
    if(btn) btn.classList.remove('running');
    if(ts){ts.className='task-status done';if(ti)ti.textContent='✓';if(tt)tt.textContent='就绪';}
  }
  if (sess&&(!sess.messages||sess.messages.length===0)) { send('load-history',{instanceId:instanceId,sessionKey:sessionKey}); }
  renderMessages();
  updateModelBadge();
  var ia=document.getElementById('input-area'); if(ia) ia.style.display='block';
  var ec=document.getElementById('empty-chat'); if(ec) ec.style.display='none';
  // scroll after render + delay for history load
  scrollToBottom();
  setTimeout(scrollToBottom, 300);
  document.getElementById('msg-input').focus();
  // Auto-close sidebar on mobile
  var panel = document.getElementById('session-panel');
  var overlay = document.getElementById('sidebar-overlay');
  if (panel && panel.classList.contains('open')) { panel.classList.remove('open'); if (overlay) overlay.classList.remove('show'); }
}

function refreshSessions() {
  if (!activeInstanceId) { console.warn('[Panel] refreshSessions: no activeInstanceId'); return; }
  console.log('[Panel] refreshSessions: instanceId=' + activeInstanceId);
  send('refresh-sessions', {instanceId: activeInstanceId});
  toast('正在刷新...', 'info', 1500);
}

// ===== Send Message =====
function sendMessage() {
  var input=document.getElementById('msg-input');
  var text=input.value.trim();
  if (!text&&attachments.length===0) return;
  if (!activeInstanceId||!activeSessionKey) return;
  var inst=instances.find(function(i){return i.id===activeInstanceId});
  var sess=inst?inst.sessions.find(function(s){return s.key===activeSessionKey}):null;
  // Upload files first, then send
  if (attachments.length>0) {
    var pending = attachments.length;
    var uploaded = [];
    attachments.forEach(function(att) {
      var fd = new FormData();
      fd.append('file', att.file);
      fetch(resolveUrl('/api/upload'),{method:'POST',body:fd})
        .then(function(r){return r.json()})
        .then(function(info) {
          uploaded.push({filename:info.filename,size:info.size,mimetype:info.mimetype,url:info.url,localPath:info.path});
          if (--pending===0) {
            // Add user message with image URLs for display
            if (sess) {
              if (!sess.messages) sess.messages=[];
              sess.messages.push({role:'user',content:text,ts:Date.now(),_uploads:uploaded});
              renderMessages(); scrollToBottom();
            }
            doSend(text, uploaded);
          }
        });
    });
  } else {
    // Add message once (no duplicates)
    if (sess) {
      if (!sess.messages) sess.messages=[];
      sess.messages.push({role:'user',content:text,ts:Date.now()});
      renderMessages(); scrollToBottom();
    }
    doSend(text, null);
  }
  input.value=''; input.style.height='auto';
  document.getElementById('send-btn').disabled=true;
  clearAttachments();
}

function doSend(text, uploaded) {
  send('send-message',{instanceId:activeInstanceId,sessionKey:activeSessionKey,text:text,attachments:uploaded});
}

function onInputKey(e) {
  // Command palette navigation
  if (cmdPaletteVisible()) {
    if (e.key==='ArrowDown') { e.preventDefault(); cmdNav(1); return; }
    if (e.key==='ArrowUp') { e.preventDefault(); cmdNav(-1); return; }
    if (e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey) { e.preventDefault(); cmdSelect(); return; }
    if (e.key==='Escape') { hideCmdPalette(); return; }
  }
  // Enter = send, Ctrl+Enter or Shift+Enter = newline
  if (e.key==='Enter'&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey) { e.preventDefault(); sendMessage(); }
  var el=e.target; el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px';
  document.getElementById('send-btn').disabled=!el.value.trim()&&attachments.length===0;
}

function onMsgInput() {
  var el=document.getElementById('msg-input');
  var val=el.value;
  document.getElementById('send-btn').disabled=!val.trim()&&attachments.length===0;
  el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px';
  // Char count
  var cc=document.getElementById('char-count');
  cc.textContent=val.length>0?val.length+' chars':'';
  // Slash command detection
  if (val==='/') { showCmdPalette(COMMANDS); }
  else if (val.startsWith('/')&&!val.includes(' ')) {
    var q=val.substring(1).toLowerCase();
    var filtered=COMMANDS.filter(function(c){return c.name.indexOf(q)>=1});
    if (filtered.length>0) showCmdPalette(filtered); else hideCmdPalette();
  } else { hideCmdPalette(); }
}

// ===== Command Palette =====
function showCmdPalette(cmds) {
  cmdFiltered=cmds; cmdIndex=0;
  var pal=document.getElementById('cmd-palette');
  pal.innerHTML=cmds.map(function(c,i){
    return '<div class="cmd-item'+(i===0?' active':'')+'" onmousedown="cmdClick('+i+')"><span class="cmd-icon">'+c.icon+'</span><span class="cmd-name">'+esc(c.name)+'</span><span class="cmd-desc">'+esc(c.desc)+'</span></div>';
  }).join('');
  pal.classList.add('show');
}
function hideCmdPalette() { document.getElementById('cmd-palette').classList.remove('show'); cmdIndex=-1; }
function cmdPaletteVisible() { return document.getElementById('cmd-palette').classList.contains('show'); }
function cmdNav(dir) {
  var items=document.querySelectorAll('.cmd-item');
  if (!items.length) return;
  items[cmdIndex]&&items[cmdIndex].classList.remove('active');
  cmdIndex=(cmdIndex+dir+items.length)%items.length;
  items[cmdIndex]&&items[cmdIndex].classList.add('active');
}
function cmdSelect() {
  if (cmdIndex>=0&&cmdIndex<cmdFiltered.length) {
    var cmd=cmdFiltered[cmdIndex];
    var input=document.getElementById('msg-input');
    // Execute command
    if (cmd.name==='/new') { showNewSessionModal(); input.value=''; }
    else if (cmd.name==='/clear') { showModal({title:'清空消息',text:'清空当前会话消息？此操作不可撤销。',confirmText:'清空'}).then(function(ok){if(ok){input.value='/clear';sendMessage();}}); }
    else if (cmd.name==='/stop') { abortRun(); input.value=''; }
    else if (cmd.name==='/help') { input.value='/help'; sendMessage(); }
    else if (cmd.name==='/commands') { input.value='/commands'; sendMessage(); }
    else { input.value=cmd.name+' '; }
    hideCmdPalette(); onMsgInput();
  }
}
function cmdClick(i) { cmdIndex=i; cmdSelect(); }

// ===== Attachments =====
function triggerFileUpload() { document.getElementById('file-input').click(); }
function triggerImageUpload() { document.getElementById('image-input').click(); }

function onFilesSelected(files) {
  for (var i=0;i<files.length;i++) {
    var f=files[i];
    if (f.size>MAX_FILE_SIZE) { alert(f.name+' 超过50MB限制'); continue; }
    attachments.push({file:f,preview:null});
    if (f.type.startsWith('image/')) {
      (function(file,idx){
        var reader=new FileReader();
        reader.onload=function(e){attachments[idx].preview=e.target.result;renderAttachments();};
        reader.readAsDataURL(file);
      })(f,attachments.length-1);
    }
  }
  renderAttachments();
  document.getElementById('send-btn').disabled=false;
}

function removeAttachment(idx) {
  attachments.splice(idx,1);
  renderAttachments();
  var input=document.getElementById('msg-input');
  document.getElementById('send-btn').disabled=!input.value.trim()&&attachments.length===0;
}

function clearAttachments() { attachments=[]; renderAttachments(); }

function renderAttachments() {
  var el=document.getElementById('attach-preview');
  var count=document.getElementById('attach-count');
  if (attachments.length===0) { el.innerHTML=''; count.textContent=''; return; }
  count.textContent=attachments.length+' 文件';
  el.innerHTML=attachments.map(function(a,idx){
    if (a.preview) {
      return '<div class="attach-thumb"><img src="'+a.preview+'"><button class="remove" onclick="removeAttachment('+idx+')">✕</button></div>';
    }
    var icon=a.file.type.startsWith('image/')?'🖼️':a.file.type.startsWith('video/')?'🎬':a.file.type.startsWith('audio/')?'🎵':'📄';
    return '<div class="attach-file">'+icon+' '+esc(a.file.name.substring(0,20))+' ('+fmtBytes(a.file.size)+')<button class="remove" onclick="removeAttachment('+idx+')">✕</button></div>';
  }).join('');
}

// Drag & Drop
document.addEventListener('dragover',function(e){e.preventDefault();if(activeSessionKey)document.getElementById('drop-overlay').classList.add('show');});
document.addEventListener('dragleave',function(e){if(e.relatedTarget===null)document.getElementById('drop-overlay').classList.remove('show');});
document.addEventListener('drop',function(e){
  e.preventDefault();
  document.getElementById('drop-overlay').classList.remove('show');
  if (!activeSessionKey) return;
  var files=e.dataTransfer.files;
  if (files.length) onFilesSelected(files);
});

// Paste images from clipboard
document.addEventListener('paste',function(e){
  if (!activeSessionKey) return;
  var items=e.clipboardData&&e.clipboardData.items;
  if (!items) return;
  var files=[];
  for (var i=0;i<items.length;i++){
    if (items[i].type.startsWith('image/')){
      var blob=items[i].getAsFile();
      if (blob) files.push(blob);
    }
  }
  if (files.length){e.preventDefault();onFilesSelected(files);}
});

// ===== Lightbox =====
function openLightbox(src) { document.getElementById('lightbox-img').src=src; document.getElementById('lightbox').classList.add('show'); }
function closeLightbox() { document.getElementById('lightbox').classList.remove('show'); }

// ===== Toast Notifications =====
function toast(msg, type='info', duration=3000) {
  var c=document.getElementById('toast-container');
  var t=document.createElement('div');
  t.className='toast '+type;
  t.textContent=msg;
  c.appendChild(t);
  requestAnimationFrame(function(){t.classList.add('show');});
  setTimeout(function(){
    t.classList.remove('show');
    setTimeout(function(){t.remove();},300);
  },duration);
}

// ===== Custom Modal (replaces confirm/prompt) =====
function showModal(opts) {
  // opts: { title, text, input (boolean), inputDefault, confirmText, cancelText, onConfirm(value) }
  return new Promise(function(resolve){
    var overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s';
    var box=document.createElement('div');
    box.style.cssText='background:#fff;border-radius:12px;padding:24px;min-width:300px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.2);transform:scale(.95);transition:transform .2s';
    var title=opts.title||'确认';
    var html='<div style="font-size:15px;font-weight:600;margin-bottom:12px">'+esc(title)+'</div>';
    if(opts.text) html+='<div style="font-size:13px;color:#666;margin-bottom:16px;line-height:1.5">'+esc(opts.text)+'</div>';
    if(opts.input) html+='<input id="modal-input" value="'+esc(opts.inputDefault||'')+'" style="width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-bottom:16px;box-sizing:border-box">';
    html+='<div style="display:flex;gap:8px;justify-content:flex-end">';
    html+='<button id="modal-cancel" style="padding:7px 16px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;font-size:13px">'+esc(opts.cancelText||'取消')+'</button>';
    html+='<button id="modal-confirm" style="padding:7px 16px;border:none;border-radius:6px;background:#6366f1;color:#fff;cursor:pointer;font-size:13px">'+esc(opts.confirmText||'确定')+'</button>';
    html+='</div>';
    box.innerHTML=html;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(function(){overlay.style.opacity='1';box.style.transform='scale(1)';});
    var inp=box.querySelector('#modal-input');
    if(inp){setTimeout(function(){inp.focus();inp.select();},100);}
    function close(val){
      overlay.style.opacity='0';box.style.transform='scale(.95)';
      setTimeout(function(){overlay.remove();},200);
      resolve(val);
    }
    box.querySelector('#modal-cancel').onclick=function(){close(null);};
    box.querySelector('#modal-confirm').onclick=function(){close(inp?inp.value:true);};
    overlay.addEventListener('click',function(e){if(e.target===overlay)close(null);});
    document.addEventListener('keydown',function handler(e){
      if(e.key==='Escape'){close(null);document.removeEventListener('keydown',handler);}
      if(e.key==='Enter'){close(inp?inp.value:true);document.removeEventListener('keydown',handler);}
    });
  });
}

// ===== Markdown Insert =====
function insertMd(before, after) {
  var el=document.getElementById('msg-input');
  var start=el.selectionStart, end=el.selectionEnd;
  var text=el.value;
  var selected=text.substring(start,end);
  el.value=text.substring(0,start)+before+selected+after+text.substring(end);
  el.focus();
  el.selectionStart=start+before.length;
  el.selectionEnd=start+before.length+selected.length;
  onMsgInput();
}

// ===== Render =====
function renderAgents() {
  var bar = document.getElementById('agent-bar');
  var activeIds = getActiveAgentIds();
  var html = AGENT_DEFS.map(function(a) {
    var isActive = a.id === activeAgentId;
    var hasSessions = activeIds[a.id];
    // Count unread messages for this agent (sum across all sessions)
    var unreadMsgs = 0;
    var unreadSessCount = 0;
    unreadSessions.forEach(function(count, key) {
      var iid = key.split('/')[0];
      var inst = instances.find(function(i){return i.id===iid});
      if (!inst) return;
      var sess = inst.sessions.find(function(s){return s.key===key.split('/').slice(1).join('/')});
      if (sess && (sess.agent||'main') === a.id) { unreadMsgs += count; unreadSessCount++; }
    });
    var hasUnread = unreadMsgs > 0;
    var badgeHtml = hasUnread ? '<span class="badge">' + (unreadMsgs > 99 ? '99+' : unreadMsgs) + '</span>' : '<span class="badge hidden"></span>';
    var bgOpacity = hasSessions ? '22' : '08';
    var borderColor = isActive ? a.color : 'transparent';
    var grayscale = hasSessions ? '' : 'filter:grayscale(0.7) opacity(0.5);';
    var dotClass = hasSessions ? 'online' : 'offline';
    return '<div class="agent-icon' + (isActive ? ' active' : '') + (hasUnread ? ' has-unread' : '') + '" data-agent="' + a.id + '" onclick="selectAgent(\'' + a.id + '\')" style="background:' + a.color + bgOpacity + ';color:' + a.color + ';border-color:' + borderColor + ';' + grayscale + '" title="' + a.name + (hasUnread ? ' · ' + unreadSessCount + ' 会话 · ' + unreadMsgs + ' 条未读' : '') + '">' +
      a.emoji + badgeHtml +
      '<span class="status-dot ' + dotClass + '"></span></div>';
  }).join('');
  // Add manage agents button at the bottom
  html += '<div class="agent-icon agent-manage-btn" onclick="openAgentManager()" title="管理 Agent" style="color:var(--dim)">⚙️</div>';
  bar.innerHTML = html;
}

// Legacy alias — kept so WS handler doesn't break
function renderInstances() { renderAgents(); }

function renderSessions() {
  var list = document.getElementById('session-list');
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  if (!inst) { list.innerHTML='<div class="session-disconnected">未连接 Gateway</div>'; return; }
  if (inst.status!=='online') { list.innerHTML='<div class="session-disconnected"><div>'+(inst.status==='connecting'?'连接中...':'离线')+'</div><button onclick="refreshSessions()">重新连接</button></div>'; return; }

  // Filter sessions by active agent
  var allSessions = inst.sessions || [];
  var sessions = allSessions.filter(function(s){return (s.agent||'main')===activeAgentId;});

  // Sort: pinned first → unread second → rest by lastActivity desc
  var pinnedS = [], unreadS = [], normalS = [];
  sessions.forEach(function(s) {
    if (s.pinned) pinnedS.push(s);
    else if (unreadSessions.has(inst.id+'/'+s.key)) unreadS.push(s);
    else normalS.push(s);
  });
  var sorted = pinnedS.concat(unreadS, normalS);

  if (sorted.length===0) { list.innerHTML='<div class="session-disconnected"><div>暂无 ' + getAgentDef(activeAgentId).name + ' 会话</div><button onclick="showNewSessionModal()">新建会话</button></div>'; return; }
  list.innerHTML=sorted.map(function(s){
    var preview=s.lastPreview||'';
    var time=s.lastActivity?fmtTime(s.lastActivity):'';
    var isUnread=unreadSessions.has(inst.id+'/'+s.key);
    var unreadCount=isUnread?unreadSessions.get(inst.id+'/'+s.key):0;
    var unreadHtml=isUnread?'<span class="unread-count">'+unreadCount+' 未读</span>':'';
    return '<div class="session-item '+(s.key===activeSessionKey?'active':'')+(isUnread?' unread':'')+'" onclick="selectSession(\''+inst.id+'\',\''+esc(s.key)+'\')"><span class="s-icon">'+(s.pinned?'📌':(s.key==='main'?'🏠':'💬'))+'</span><div class="s-info"><div class="s-name">'+esc(s.name)+unreadHtml+'</div><div class="s-preview">'+esc(preview)+'</div></div><span class="s-time">'+time+'</span><button class="sess-more-btn" onclick="event.stopPropagation();openSessMenu(event,\''+inst.id+'\',\''+esc(s.key)+'\','+s.pinned+')" title="更多操作">⋯</button></div>';
  }).join('')+'<button class="new-session-btn" onclick="showNewSessionModal()">+ 新建会话</button>';
  filterSessions();
  updateMarkAllReadBtn();
}

function renderMessages() {
  var container=document.getElementById('messages');
  var inst=instances.find(function(i){return i.id===activeInstanceId});
  var sess=inst?inst.sessions.find(function(s){return s.key===activeSessionKey}):null;
  if (!sess) { container.innerHTML='<div class="empty-chat" id="empty-chat"><div class="icon">🦞</div><p>选择一个会话开始聊天</p></div>'; var ch2=document.getElementById('chat-header'); if(ch2) ch2.style.display='none'; var ia2=document.getElementById('input-area'); if(ia2) ia2.style.display='none'; return; }
  var msgs=sess.messages||[];
  if (msgs.length===0) { container.innerHTML='<div class="empty-chat"><div class="icon">💬</div><p>开始对话吧</p></div>'; return; }
  var html='',lastDate='';
  for (var i=0;i<msgs.length;i++) {
    var m=msgs[i];
    var d=m.ts?fmtDate(m.ts):'';
    if (d&&d!==lastDate) { html+='<div class="date-sep"><span>'+d+'</span></div>'; lastDate=d; }
    var role=m.role==='user'?'user':'agent';
    var content=renderContent(m.content||m.text||'');
    // Show uploaded images: from _uploads or parsed from message text
    var uploadsHtml='';
    if (m._uploads&&m._uploads.length>0) {
      uploadsHtml='<div class="msg-images">'+m._uploads.filter(function(u){return u.mimetype&&u.mimetype.startsWith('image/')}).map(function(u){return '<div class="msg-image"><img src="'+u.url+'" loading="lazy" /></div>';}).join('')+'</div>';
    } else if (m.role==='user') {
      var textContent=typeof (m.content||m.text)==='string'?(m.content||m.text):'';
      var fileRe=/📎 已上传文件: (\S+) \(([^,]+), (image\/[^)]+)\)/g;
      var match,imgUrls=[];
      while((match=fileRe.exec(textContent))!==null) {
        var fname=match[1].split('/').pop();
        imgUrls.push('/uploads/'+fname);
      }
      if(imgUrls.length>0) uploadsHtml='<div class="msg-images">'+imgUrls.map(function(u){return '<div class="msg-image"><img src="'+u+'" loading="lazy" /></div>';}).join('')+'</div>';
    }
    var time=m.ts?fmtTime(m.ts):'';
    var model=m.model?'<span class="model">'+esc(m.model)+'</span>':'';
    var usage=m.usage&&m.usage.totalTokens?'<span class="model">'+m.usage.totalTokens+' tok</span>':'';
    var actionBtns = '<button onclick="copyMsg(this)" title="复制">📋</button>';
    if (role === 'user') {
      actionBtns += '<button onclick="editAndResend(this)" title="编辑重发">✏️</button>';
      actionBtns += '<button onclick="delegateToAgent(this)" title="委派给其他 Agent">🔀</button>';
    } else {
      actionBtns += '<button onclick="retryFromMsg(this)" title="从此重试">🔄</button>';
    }
    actionBtns += '<button onclick="toggleReactBar(this)" title="表情反应">😊</button>';
    var reactBar = '<div class="react-bar" style="display:none"><span onclick="addReaction(this,\'👍\')">👍</span><span onclick="addReaction(this,\'❤️\')">❤️</span><span onclick="addReaction(this,\'😂\')">😂</span><span onclick="addReaction(this,\'🎉\')">🎉</span><span onclick="addReaction(this,\'👀\')">👀</span><span onclick="addReaction(this,\'🔥\')">🔥</span></div>';
    var reactHtml = '';
    if (m._reactions && Object.keys(m._reactions).length > 0) {
      reactHtml = '<div class="msg-reactions">';
      for (var emoji in m._reactions) { reactHtml += '<span class="reaction-badge" onclick="removeReaction(this,\''+emoji+'\')">'+emoji+' '+m._reactions[emoji]+'</span>'; }
      reactHtml += '</div>';
    }
    // Hide message only if ALL content is just 📎 file upload text (no real user text)
    var rawContent = m.content || m.text || '';
    var strippedContent = typeof rawContent === 'string' ? rawContent.replace(/\n?📎 已上传文件:.*$/gm, '').trim() : '';
    var fileFilterAttr = (role==='user' && typeof rawContent==='string' && /📎 已上传文件:/.test(rawContent) && !strippedContent) ? ' style="display:none"' : '';
    html+='<div class="msg '+role+'"' + fileFilterAttr + '><div class="msg-actions">'+actionBtns+'</div>'+reactBar+uploadsHtml+content+reactHtml+'<div class="meta">'+time+model+usage+'</div></div>';
  }
  container.innerHTML=html;
  container.querySelectorAll('.collapsible-header').forEach(function(el){el.addEventListener('click',function(){el.parentElement.classList.toggle('collapsed');});});
  container.querySelectorAll('.msg-image img').forEach(function(img){img.addEventListener('click',function(){openLightbox(img.src);});});
  addCodeCopyButtons();
  applyFilters();
  // Update session info in header
  updateSessionStats();
  // Update file panel
  updateFilePanel();
  // Sync rendered count
  _renderedMsgCount = msgs.length;
}

// Incremental render: only append new messages (much faster for long conversations)
function renderMessagesAppend() {
  var container=document.getElementById('messages');
  var inst=instances.find(function(i){return i.id===activeInstanceId});
  var sess=inst?inst.sessions.find(function(s){return s.key===activeSessionKey}):null;
  if (!sess) { renderMessages(); return; }
  var msgs=sess.messages||[];
  if (msgs.length===0) { renderMessages(); return; }
  // If nothing rendered yet, do full render
  if (_renderedMsgCount===0) { renderMessages(); return; }
  // If we have fewer messages than rendered (e.g. history reload), do full render
  if (msgs.length<_renderedMsgCount) { renderMessages(); return; }
  // Nothing new to append
  if (msgs.length===_renderedMsgCount) {
    // Just update the last message (it may have gotten model/usage data)
    var lastMsgEl=container.querySelector('.msg:last-child');
    if (lastMsgEl) {
      var lastMsg=msgs[msgs.length-1];
      var metaEl=lastMsgEl.querySelector('.meta');
      if (metaEl&&lastMsg) {
        var time=lastMsg.ts?fmtTime(lastMsg.ts):'';
        var model=lastMsg.model?'<span class="model">'+esc(lastMsg.model)+'</span>':'';
        var usage=lastMsg.usage&&lastMsg.usage.totalTokens?'<span class="model">'+lastMsg.usage.totalTokens+' tok</span>':'';
        metaEl.innerHTML=time+model+usage;
      }
    }
    return;
  }
  // Append only new messages
  var html='';
  var lastDate='';
  // Find last date separator
  var dateSeps=container.querySelectorAll('.date-sep span');
  if (dateSeps.length>0) lastDate=dateSeps[dateSeps.length-1].textContent;
  for (var i=_renderedMsgCount;i<msgs.length;i++) {
    var m=msgs[i];
    var d=m.ts?fmtDate(m.ts):'';
    if (d&&d!==lastDate) { html+='<div class="date-sep"><span>'+d+'</span></div>'; lastDate=d; }
    var role=m.role==='user'?'user':'agent';
    var content=renderContent(m.content||m.text||'');
    var uploadsHtml='';
    if (m._uploads&&m._uploads.length>0) {
      uploadsHtml='<div class="msg-images">'+m._uploads.filter(function(u){return u.mimetype&&u.mimetype.startsWith('image/')}).map(function(u){return '<div class="msg-image"><img src="'+u.url+'" loading="lazy" /></div>';}).join('')+'</div>';
    }
    var time=m.ts?fmtTime(m.ts):'';
    var model=m.model?'<span class="model">'+esc(m.model)+'</span>':'';
    var usage=m.usage&&m.usage.totalTokens?'<span class="model">'+m.usage.totalTokens+' tok</span>':'';
    var actionBtns='<button onclick="copyMsg(this)" title="复制">📋</button>';
    if (role==='user') { actionBtns+='<button onclick="editAndResend(this)" title="编辑重发">✏️</button>'; actionBtns+='<button onclick="delegateToAgent(this)" title="委派给其他 Agent">🔀</button>'; }
    else { actionBtns+='<button onclick="retryFromMsg(this)" title="从此重试">🔄</button>'; }
    actionBtns+='<button onclick="toggleReactBar(this)" title="表情反应">😊</button>';
    var reactBar='<div class="react-bar" style="display:none"><span onclick="addReaction(this,\'👍\')">👍</span><span onclick="addReaction(this,\'❤️\')">❤️</span><span onclick="addReaction(this,\'😂\')">😂</span><span onclick="addReaction(this,\'🎉\')">🎉</span><span onclick="addReaction(this,\'👀\')">👀</span><span onclick="addReaction(this,\'🔥\')">🔥</span></div>';
    var reactHtml='';
    if (m._reactions&&Object.keys(m._reactions).length>0) {
      reactHtml='<div class="msg-reactions">';
      for (var emoji in m._reactions) { reactHtml+='<span class="reaction-badge" onclick="removeReaction(this,\''+emoji+'\')">'+emoji+' '+m._reactions[emoji]+'</span>'; }
      reactHtml+='</div>';
    }
    // Hide message only if ALL content is just 📎 file upload text (no real user text)
    var rawContent2 = m.content || m.text || '';
    var strippedContent2 = typeof rawContent2 === 'string' ? rawContent2.replace(/\n?📎 已上传文件:.*$/gm, '').trim() : '';
    var fileFilterAttr = (role==='user' && typeof rawContent2==='string' && /📎 已上传文件:/.test(rawContent2) && !strippedContent2) ? ' style="display:none"' : '';
    html+='<div class="msg '+role+'"' + fileFilterAttr + '><div class="msg-actions">'+actionBtns+'</div>'+reactBar+uploadsHtml+content+reactHtml+'<div class="meta">'+time+model+usage+'</div></div>';
  }
  // Use insertAdjacentHTML for efficient append (no full DOM rebuild)
  container.insertAdjacentHTML('beforeend', html);
  // Bind events only for new elements
  var newCollapsibles=container.querySelectorAll('.collapsible-header');
  newCollapsibles.forEach(function(el){if(!el._bound){el._bound=true;el.addEventListener('click',function(){el.parentElement.classList.toggle('collapsed');});}});
  var newImages=container.querySelectorAll('.msg-image img');
  newImages.forEach(function(img){if(!img._bound){img._bound=true;img.addEventListener('click',function(){openLightbox(img.src);});}});
  addCodeCopyButtons();
  applyFilters();
  scrollToBottom();
  _renderedMsgCount=msgs.length;
  updateSessionStats();
  updateFilePanel();
}

// Debounced full render — batches rapid updates
function renderMessagesDebounced() {
  if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
  _renderDebounceTimer = setTimeout(function(){ _renderDebounceTimer=null; renderMessages(); scrollToBottom(); updateModelBadge(); }, 80);
}

// ===== File Download (Tauri-compatible) =====
// Tauri WebView doesn't support fetch+blob downloads reliably.
// Use Tauri shell.open to launch the system browser for native downloads.
function downloadFile(url, filename) {
  url = resolveUrl(url);
  console.log('[Download]', url);

  var btn = event && event.currentTarget;
  if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }

  var opened = false;
  // Tauri v2: __TAURI_PLUGIN_SHELL__.open(url)
  // Tauri v1: __TAURI__.shell.open(url)
  // Browser: window.open(url, '_blank')
  if (typeof window.__TAURI_PLUGIN_SHELL__ !== 'undefined' && window.__TAURI_PLUGIN_SHELL__.open) {
    console.log('[Download] using __TAURI_PLUGIN_SHELL__.open');
    window.__TAURI_PLUGIN_SHELL__.open(url);
    opened = true;
  }
  if (!opened && typeof window.__TAURI__ !== 'undefined' && window.__TAURI__.shell && window.__TAURI__.shell.open) {
    console.log('[Download] using __TAURI__.shell.open');
    window.__TAURI__.shell.open(url);
    opened = true;
  }
  if (!opened) {
    console.log('[Download] using window.open fallback');
    window.open(url, '_blank');
  }

  if (btn) { setTimeout(function() { btn.style.opacity = ''; btn.style.pointerEvents = ''; }, 500); }
}

// ===== File Panel =====
function getFileIcon(ext) {
  var icons = {
    md: '📝', txt: '📄', json: '📋', log: '📜',
    js: '📜', py: '🐍', sh: '⚙️', bash: '⚙️',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
    zip: '📦', tar: '📦', gz: '📦', rar: '📦', '7z': '📦',
    csv: '📊', tsv: '📊', yaml: '⚙️', yml: '⚙️', toml: '⚙️', ini: '⚙️',
    html: '🌐', css: '🎨', xml: '📰',
    mp3: '🎵', wav: '🎵', mp4: '🎬', avi: '🎬', mov: '🎬',
    conf: '⚙️', cfg: '⚙️', env: '⚙️',
  };
  return icons[ext] || '📄';
}

function extractFilesFromMessages() {
  var inst = instances.find(function(i) { return i.id === activeInstanceId; });
  var sess = inst ? inst.sessions.find(function(s) { return s.key === activeSessionKey }) : null;
  if (!sess) return [];
  var msgs = sess.messages || [];
  var files = [];
  var seen = {};

  // File path patterns
  var pathRegex = /(?:^|\s)((?:\/[\w.\-]+)+(?:\.\w+)|(?:[\w.\-]+\/)+[\w.\-]+\.\w+|(?:knowledge-base|scripts|lib|public|uploads|memory|workspace|tmp)\/[\w.\-\/]+\.\w+)(?=\s|$|[),;:])/g;

  for (var i = 0; i < msgs.length; i++) {
    var content = msgs[i].content || msgs[i].text || '';
    if (typeof content !== 'string') content = JSON.stringify(content);
    var match;
    while ((match = pathRegex.exec(content)) !== null) {
      var filePath = match[1].trim();
      if (!/\.\w{1,10}$/.test(filePath)) continue;
      if (seen[filePath]) continue;
      seen[filePath] = true;
      var fileName = filePath.split('/').pop();
      var ext = fileName.split('.').pop().toLowerCase();
      files.push({
        path: filePath,
        name: fileName,
        ext: ext,
        icon: getFileIcon(ext),
        url: '/api/download?path=' + encodeURIComponent(filePath)
      });
    }
  }
  return files;
}

function updateFilePanel() {
  var panel = document.getElementById('file-panel');
  var list = document.getElementById('file-panel-list');
  var count = document.getElementById('file-panel-count');
  if (!panel || !list) return;

  var files = extractFilesFromMessages();
  if (files.length === 0) {
    panel.classList.remove('show');
    return;
  }

  count.textContent = files.length;
  panel.classList.add('show');

  var html = '';
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    html += '<span class="file-chip" onclick="downloadFile(\'' + f.url + '\',\'' + esc(f.name) + '\')" title="' + esc(f.path) + '">';
    html += '<span class="file-icon">' + f.icon + '</span>';
    html += '<span class="file-name">' + esc(f.name) + '</span>';
    html += '<span class="file-dl">📥</span>';
    html += '</span>';
  }
  list.innerHTML = html;
  // Default collapsed
  list.classList.add('collapsed');
  document.getElementById('file-panel-toggle').textContent = '▶';
}

function toggleFilePanel() {
  var list = document.getElementById('file-panel-list');
  var toggle = document.getElementById('file-panel-toggle');
  list.classList.toggle('collapsed');
  toggle.textContent = list.classList.contains('collapsed') ? '▶' : '▼';
}

function renderContent(content) {
  if (typeof content==='string') {
    // Strip 📎 file upload metadata lines (shown inline as images instead)
    content = content.replace(/\n?📎 已上传文件:.*$/gm, '').trim();
    // Strip Gateway's "[non-text content: ...]" placeholders
    content = content.replace(/\s*\[non-text content:[^\]]*\]/g, '').trim();
    if (!content) return '';
    return renderTextContent(content);
  }
  if (Array.isArray(content)) return content.map(function(p){return renderPart(p);}).join('');
  return renderTextContent(JSON.stringify(content,null,2));
}

function renderPart(part) {
  if (!part||!part.type) return '';
  switch (part.type) {
    case 'text': return '<div class="content-text">'+renderTextContent(part.text||'')+'</div>';
    case 'image': return renderImagePart(part);
    case 'thinking': return '<div class="collapsible-section collapsed" data-filter="thinking"><div class="collapsible-header"><span class="chevron">▸</span> 💭 思考过程</div><div class="collapsible-body"><div class="thinking-block">'+renderTextContent(part.thinking||'')+'</div></div></div>';
    case 'toolCall': var args=part.arguments?JSON.stringify(part.arguments).substring(0,200):''; return '<div class="collapsible-section collapsed" data-filter="tools"><div class="collapsible-header"><span class="chevron">▸</span> 🔧 '+esc(part.name||'tool')+'</div><div class="collapsible-body"><pre class="tool-args">'+esc(args)+'</pre></div></div>';
    case 'toolResult': var rc=part.content,rh=''; if (Array.isArray(rc)) rh=rc.map(function(p){return renderPart(p);}).join(''); else if (typeof rc==='string') { var preview=rc.substring(0,3000); if(rc.length>3000) preview+='<p style="color:var(--dim);font-size:11px">... 共 '+rc.length+' 字符</p>'; rh=renderTextContent(preview); } var st=part.isError?'❌':'✅'; return '<div class="collapsible-section collapsed" data-filter="tools"><div class="collapsible-header"><span class="chevron">▸</span> '+st+' '+esc(part.toolName||'result')+'</div><div class="collapsible-body">'+rh+'</div></div>';
    default: return '<div class="collapsible-section collapsed" data-filter="tools"><div class="collapsible-header"><span class="chevron">▸</span> 📦 '+esc(part.type)+'</div><div class="collapsible-body"><pre>'+esc(JSON.stringify(part,null,2).substring(0,1000))+'</pre></div></div>';
  }
}

function renderImagePart(part) {
  if (part.data) { var mime=part.mimeType||'image/png'; return '<div class="msg-image"><img src="data:'+mime+':base64,'+part.data+'" loading="lazy" /></div>'; }
  var details=part.details||{};
  var mediaUrl=details.media&&details.media.mediaUrl||details.path||part.path||part.mediaUrl||part.url;
  if (mediaUrl) {
    var mp=mediaUrl.replace(/^\/home\/pi\/\.openclaw\/media\//,'/media/');
    if (mp.startsWith('/media/')||mp.startsWith('http')||mp.startsWith('/uploads/')) return '<div class="msg-image"><img src="'+mp+'" loading="lazy" /></div>';
  }
  return '<div style="padding:12px;background:var(--bg);border-radius:8px;text-align:center;font-size:13px;color:var(--dim)">[图片]</div>';
}

function renderTextContent(text) {
  if (typeof text!=='string') text=JSON.stringify(text,null,2);
  // Escape HTML first to prevent XSS and DOM injection
  var s = esc(text);
  // === P1: Detect file paths and add download buttons ===
  // Match patterns like: knowledge-base/*.md, scripts/*, lib/*, public/*, uploads/*, *.log, *.json, *.txt, *.js, *.py, etc.
  // Also match absolute paths like /home/pi/.openclaw/...
  s = s.replace(/(?:^|\s)((?:\/[\w.\-]+)+(?:\.\w+)|(?:[\w.\-]+\/)+[\w.\-]+\.\w+|(?:knowledge-base|scripts|lib|public|uploads|memory|workspace|tmp)\/[\w.\-\/]+\.\w+)(?=\s|$|[),;:])/g, function(match, filePath) {
    var trimmed = filePath.trim();
    // Validate it looks like a real file path (has extension)
    if (!/\.\w{1,10}$/.test(trimmed)) return match;
    var downloadUrl = '/api/download?path=' + encodeURIComponent(trimmed);
    var fileName = trimmed.split('/').pop();
    return match + ' <span class="file-download-btn" onclick="downloadFile(\'' + downloadUrl + '\',\'' + esc(fileName) + '\')" title="下载文件 ' + esc(fileName) + '">📥</span>';
  });
  // Code blocks (```\lang\n...\n```)
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
    return '\n<pre><code>' + code + '</code></pre>\n';
  });
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Headers (must be at line start)
  s = s.replace(/^#### (.+)$/gm, '\n<h4>$1</h4>\n');
  s = s.replace(/^### (.+)$/gm, '\n<h3>$1</h3>\n');
  s = s.replace(/^## (.+)$/gm, '\n<h2>$1</h2>\n');
  s = s.replace(/^# (.+)$/gm, '\n<h1>$1</h1>\n');
  // Blockquotes (consecutive > lines merged into one blockquote)
  s = s.replace(/^(?:&gt;(?: .*)?$\n?)+/gm, function(m) {
    var lines = m.trim().split('\n').map(function(l) { return l.replace(/^&gt; ?/, ''); });
    return '<blockquote>' + lines.join('<br>') + '</blockquote>';
  });
  // Markdown tables (| header | header | style)
  s = s.replace(/^(\|.+\|)\n(\|[-: |]+\|)\n((?:\|.+\|\n?)*)/gm, function(m, headerRow, sepRow, bodyRows) {
    function parseRow(row) {
      return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(c) { return c.trim(); });
    }
    var headers = parseRow(headerRow);
    var alignments = parseRow(sepRow).map(function(c) {
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    var html = '<table><thead><tr>';
    headers.forEach(function(h, i) {
      html += '<th style="text-align:' + (alignments[i] || 'left') + '">' + h + '</th>';
    });
    html += '</tr></thead><tbody>';
    bodyRows.trim().split('\n').forEach(function(row) {
      if (!row.trim()) return;
      html += '<tr>';
      parseRow(row).forEach(function(cell, i) {
        html += '<td style="text-align:' + (alignments[i] || 'left') + '">' + cell + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    return '\n' + html + '\n';
  });
  // Horizontal rule
  s = s.replace(/^---$/gm, '\n<hr>\n');
  // Unordered list items (use temp marker)
  s = s.replace(/^- (.+)$/gm, '<uli>$1</uli>');
  s = s.replace(/(<uli>[\s\S]*?<\/uli>)+/g, function(m) {
    return '<ul>' + m.replace(/<\/?uli>/g, function(t) { return t === '<uli>' ? '<li>' : '</li>'; }) + '</ul>';
  });
  // Ordered list items (use temp marker)
  s = s.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  s = s.replace(/(<oli>[\s\S]*?<\/oli>)+/g, function(m) {
    return '<ol>' + m.replace(/<\/?oli>/g, function(t) { return t === '<oli>' ? '<li>' : '</li>'; }) + '</ol>';
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Wrap non-block content in paragraphs
  var parts = s.split(/\n\n+/);
  parts = parts.map(function(p) {
    p = p.trim();
    if (!p) return '';
    // Don't wrap block-level elements in <p>
    if (/^<(h[1-6]|pre|ul|ol|blockquote|hr|table|div)/i.test(p)) return p;
    return '<p>' + p + '</p>';
  });
  return parts.join('\n');
}

// ===== Filter Toggle =====
var searchMatches = [];
var searchIndex = -1;

function toggleFilter(type) {
  filters[type] = !filters[type];
  var btn = document.getElementById('filter-' + type + '-btn');
  if (btn) btn.classList.toggle('active', filters[type]);
  applyFilters();
}

function applyFilters() {
  // Apply thinking/tools filter using CSS class (more reliable than inline style)
  document.querySelectorAll('[data-filter]').forEach(function(el) {
    var f = el.dataset.filter;
    if (filters[f]) {
      el.classList.remove('filter-hidden');
    } else {
      el.classList.add('filter-hidden');
    }
  });
  // Update button states
  var tbtn = document.getElementById('filter-thinking-btn');
  if (tbtn) tbtn.classList.toggle('active', filters.thinking);
  var tbody = document.getElementById('filter-tools-btn');
  if (tbody) tbody.classList.toggle('active', filters.tools);
  // Apply search
  applySearch();
}

function applySearch() {
  // Clear previous highlights
  document.querySelectorAll('.msg mark.search-hl').forEach(function(m) {
    var parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
  document.querySelectorAll('.msg.search-current').forEach(function(m) { m.classList.remove('search-current'); });
  searchMatches = [];
  searchIndex = -1;

  var q = (document.getElementById('chat-search').value || '').trim();
  var nav = document.getElementById('search-nav');
  if (!q) { if(nav) nav.style.display='none'; return; }
  var qLower = q.toLowerCase();

  // Find matching messages and highlight
  var msgs = document.querySelectorAll('.msg');
  msgs.forEach(function(msgEl) {
    var textNodes = [];
    var walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while (node = walker.nextNode()) {
      if (node.parentElement.closest('.msg-actions,.meta,pre,code,.collapsible-header')) continue;
      if (node.textContent.toLowerCase().indexOf(qLower) >= 0) textNodes.push(node);
    }
    if (textNodes.length > 0) {
      searchMatches.push(msgEl);
      textNodes.forEach(function(tn) {
        var text = tn.textContent;
        var lower = text.toLowerCase();
        var frag = document.createDocumentFragment();
        var lastIdx = 0;
        var idx;
        while ((idx = lower.indexOf(qLower, lastIdx)) >= 0) {
          if (idx > lastIdx) frag.appendChild(document.createTextNode(text.substring(lastIdx, idx)));
          var mark = document.createElement('mark');
          mark.className = 'search-hl';
          mark.textContent = text.substring(idx, idx + q.length);
          frag.appendChild(mark);
          lastIdx = idx + q.length;
        }
        if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.substring(lastIdx)));
        tn.parentNode.replaceChild(frag, tn);
      });
    }
  });

  // Show nav
  if (nav) {
    if (searchMatches.length > 0) {
      nav.style.display = 'flex';
      searchIndex = 0;
      scrollToSearchMatch(0);
    } else {
      nav.style.display = 'flex';
      nav.querySelector('.search-count').textContent = '0/0';
    }
  }
}

function scrollToSearchMatch(dir) {
  if (searchMatches.length === 0) return;
  searchIndex = (searchIndex + dir + searchMatches.length) % searchMatches.length;
  document.querySelectorAll('.msg.search-current').forEach(function(m) { m.classList.remove('search-current'); });
  var target = searchMatches[searchIndex];
  target.classList.add('search-current');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  var nav = document.getElementById('search-nav');
  if (nav) nav.querySelector('.search-count').textContent = (searchIndex+1)+'/'+searchMatches.length;
}

function filterMessages() { applySearch(); }

// ===== Toggle Reaction Bar =====
function toggleReactBar(btn) {
  var msg = btn.closest('.msg');
  var bar = msg.querySelector('.react-bar');
  if (bar) {
    var visible = bar.style.display !== 'none';
    // Close all other react bars first
    document.querySelectorAll('.react-bar').forEach(function(b){b.style.display='none';});
    bar.style.display = visible ? 'none' : 'flex';
  }
}
// Close react bars when clicking elsewhere
document.addEventListener('click', function(e) {
  if (!e.target.closest('.react-bar') && !e.target.closest('.msg-actions button[title="表情反应"]')) {
    document.querySelectorAll('.react-bar').forEach(function(b){b.style.display='none';});
  }
});

// ===== Update Session Stats =====
function updateSessionStats() {
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  var el = document.getElementById('ch-stats');
  if (!el) return;
  if (!sess) { el.textContent = ''; return; }
  var msgs = sess.messages || [];
  var tokens = 0;
  msgs.forEach(function(m){if(m.usage&&m.usage.totalTokens) tokens+=m.usage.totalTokens;});
  var parts = [];
  if (msgs.length > 0) parts.push(msgs.length+' 条消息');
  if (tokens > 0) parts.push(fmtNumber(tokens)+' tok');
  el.textContent = parts.join(' · ');
}

function fmtNumber(n) {
  if (n >= 1000) return (n/1000).toFixed(1)+'k';
  return n+'';
}

// ===== Quick Reactions =====
function addReaction(btn, emoji) {
  var msgEl = btn.closest('.msg');
  if (!msgEl) return;
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  if (!sess || !sess.messages) return;
  var msgNodes = document.querySelectorAll('.msg');
  var idx = Array.from(msgNodes).indexOf(msgEl);
  if (idx < 0 || !sess.messages[idx]) return;
  var msg = sess.messages[idx];
  if (!msg._reactions) msg._reactions = {};
  msg._reactions[emoji] = (msg._reactions[emoji] || 0) + 1;
  renderReactions(msgEl, msg._reactions);
}

function renderReactions(msgEl, reactions) {
  var existing = msgEl.querySelector('.msg-reactions');
  if (existing) existing.remove();
  if (!reactions || Object.keys(reactions).length === 0) return;
  var html = '<div class="msg-reactions">';
  for (var emoji in reactions) {
    html += '<span class="reaction-badge" onclick="removeReaction(this,\''+emoji+'\')">'+emoji+' '+reactions[emoji]+'</span>';
  }
  html += '</div>';
  // Insert before meta
  var meta = msgEl.querySelector('.meta');
  if (meta) meta.insertAdjacentHTML('beforebegin', html);
}

function removeReaction(badgeEl, emoji) {
  var msgEl = badgeEl.closest('.msg');
  if (!msgEl) return;
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  if (!sess || !sess.messages) return;
  var msgNodes = document.querySelectorAll('.msg');
  var idx = Array.from(msgNodes).indexOf(msgEl);
  if (idx < 0 || !sess.messages[idx] || !sess.messages[idx]._reactions) return;
  var r = sess.messages[idx]._reactions;
  if (r[emoji] > 1) r[emoji]--;
  else delete r[emoji];
  renderReactions(msgEl, r);
}

// ===== Copy Helper (works on HTTP) =====
function copyToClipboard(text, successEl, origText) {
  // Try modern API first (HTTPS)
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function(){
      if (successEl) { successEl.textContent='✅'; setTimeout(function(){successEl.textContent=origText||'📋'},1200); }
    });
    return;
  }
  // Fallback: execCommand (works on HTTP)
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
  if (successEl) { successEl.textContent='✅'; setTimeout(function(){successEl.textContent=origText||'📋'},1200); }
}

// ===== Code Block Copy =====
function addCodeCopyButtons() {
  document.querySelectorAll('.msg pre').forEach(function(pre) {
    if (pre.querySelector('.code-copy-btn')) return;
    var btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = '📋';
    btn.title = '复制代码';
    btn.onclick = function() {
      var code = pre.querySelector('code');
      copyToClipboard(code ? code.textContent : pre.textContent, btn, '📋');
    };
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

// ===== Session Info =====
function showSessionInfo() {
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  if (!sess) return;
  var msgs = sess.messages || [];
  var userCount = msgs.filter(function(m){return m.role==='user'}).length;
  var agentCount = msgs.filter(function(m){return m.role!=='user'}).length;
  var totalTokens = 0;
  msgs.forEach(function(m){if(m.usage&&m.usage.totalTokens) totalTokens+=m.usage.totalTokens;});
  var firstMsg = msgs.length > 0 && msgs[0].ts ? fmtTime(msgs[0].ts) : '-';
  var lastMsg = msgs.length > 0 && msgs[msgs.length-1].ts ? fmtRelative(msgs[msgs.length-1].ts) : '-';
  alert('📊 会话信息\n\n名称: '+(sess.name||sess.key)+'\n消息: '+msgs.length+' (用户 '+userCount+' / AI '+agentCount+')\nToken: ~'+totalTokens+'\n首条: '+firstMsg+'\n最近: '+lastMsg);
}

// ===== Copy Message =====
function copyMsg(btn) {
  var msg=btn.closest('.msg');
  // Collect all text content from the message
  var parts = msg.querySelectorAll('.content-text, .thinking-block, .tool-args');
  var texts = [];
  parts.forEach(function(p) { texts.push(p.textContent); });
  // If no structured parts, fall back to full message text minus meta
  if (texts.length === 0) {
    var meta = msg.querySelector('.meta');
    var clone = msg.cloneNode(true);
    var actionsEl = clone.querySelector('.msg-actions');
    if (actionsEl) actionsEl.remove();
    var metaEl = clone.querySelector('.meta');
    if (metaEl) metaEl.remove();
    texts.push(clone.textContent);
  }
  var fullText = texts.join('\n\n').trim();
  if (fullText) copyToClipboard(fullText, btn, '📋');
}

// ===== Retry Message =====
function retryFromMsg(btn) {
  var msgEl = btn.closest('.msg');
  if (!msgEl) return;
  // Find the index of this message in the current session
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  if (!sess || !sess.messages) return;
  // Get all messages, find this one by position
  var msgNodes = document.querySelectorAll('.msg');
  var idx = Array.from(msgNodes).indexOf(msgEl);
  if (idx < 0) return;
  // Find the user message at or before this position
  var targetMsg = sess.messages[idx];
  if (!targetMsg) return;
  // If this is an agent message, find the preceding user message
  if (targetMsg.role !== 'user') {
    for (var j = idx - 1; j >= 0; j--) {
      if (sess.messages[j].role === 'user') { targetMsg = sess.messages[j]; break; }
    }
  }
  if (!targetMsg || targetMsg.role !== 'user') return;
  var text = typeof targetMsg.content === 'string' ? targetMsg.content : (targetMsg.text || '');
  if (!text) return;
  // Remove messages from this point onward (truncate the conversation)
  sess.messages = sess.messages.slice(0, sess.messages.indexOf(targetMsg));
  renderMessages();
  scrollToBottom();
  // Re-send
  doSend(text, null);
}

// ===== Edit & Resend =====
// ===== Copy All Messages =====
function copyAllMessages() {
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  if (!sess || !sess.messages || sess.messages.length === 0) return;
  var lines = [];
  sess.messages.forEach(function(m) {
    var role = m.role === 'user' ? '👤 User' : '🤖 Agent';
    var text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter(function(p){return p.type==='text'}).map(function(p){return p.text}).join('\n');
    } else if (m.text) text = m.text;
    if (text.trim()) lines.push(role + ':\n' + text.trim());
  });
  var allText = lines.join('\n\n---\n\n');
  var btn = document.getElementById('copy-all-btn');
  copyToClipboard(allText, btn, '📋');
}

function editAndResend(btn) {
  var msgEl = btn.closest('.msg');
  if (!msgEl) return;
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  if (!sess || !sess.messages) return;
  var msgNodes = document.querySelectorAll('.msg');
  var idx = Array.from(msgNodes).indexOf(msgEl);
  if (idx < 0) return;
  var targetMsg = sess.messages[idx];
  if (!targetMsg || targetMsg.role !== 'user') return;
  var text = typeof targetMsg.content === 'string' ? targetMsg.content : (targetMsg.text || '');
  // Put text in input for editing
  var input = document.getElementById('msg-input');
  input.value = text;
  input.focus();
  input.setSelectionRange(0, input.value.length);
  onMsgInput();
  // Store reference for "send replaces from here"
  window._editFromIdx = idx;
}

// Override sendMessage to handle edit-and-resend
var _origSendMessage = sendMessage;
sendMessage = function() {
  if (window._editFromIdx !== undefined && window._editFromIdx >= 0) {
    var inst = instances.find(function(i){return i.id===activeInstanceId});
    var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
    if (sess && sess.messages) {
      sess.messages = sess.messages.slice(0, window._editFromIdx);
    }
    window._editFromIdx = -1;
  }
  _origSendMessage();
};

// ===== P2: Delegate Message to Another Agent =====
function delegateToAgent(btn) {
  var msgEl = btn.closest('.msg');
  if (!msgEl) return;
  var inst = instances.find(function(i){return i.id===activeInstanceId});
  var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
  if (!sess || !sess.messages) return;
  var msgNodes = document.querySelectorAll('.msg');
  var idx = Array.from(msgNodes).indexOf(msgEl);
  if (idx < 0 || !sess.messages[idx]) return;
  var targetMsg = sess.messages[idx];
  var text = typeof targetMsg.content === 'string' ? targetMsg.content : (targetMsg.text || '');
  if (!text) return;

  // Show agent picker modal
  var html = '<div style="font-size:14px;font-weight:600;margin-bottom:12px">🔀 委派任务给其他 Agent</div>';
  html += '<div style="font-size:12px;color:var(--dim);margin-bottom:12px;max-height:60px;overflow:hidden;text-overflow:ellipsis">' + esc(text.substring(0, 100)) + (text.length > 100 ? '...' : '') + '</div>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">';
  AGENT_DEFS.forEach(function(a) {
    if (a.id === activeAgentId) return; // Skip current agent
    html += '<div onclick="doDelegate(\'' + a.id + '\')" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);cursor:pointer;text-align:center;min-width:80px;transition:all .15s" onmouseover="this.style.borderColor=\'' + a.color + '\'" onmouseout="this.style.borderColor=\'var(--border)\'">';
    html += '<div style="font-size:20px">' + a.emoji + '</div>';
    html += '<div style="font-size:12px;font-weight:500;margin-top:4px">' + esc(a.name) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  html += '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" onclick="closeDelegateModal()">取消</button></div>';

  // Store text for delegate
  window._delegateText = text;

  var overlay = document.createElement('div');
  overlay.id = 'delegate-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s';
  var box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;min-width:300px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.2);transform:scale(.95);transition:transform .2s';
  box.innerHTML = html;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  requestAnimationFrame(function(){overlay.style.opacity='1';box.style.transform='scale(1)';});
}

function doDelegate(agentId) {
  closeDelegateModal();
  var text = window._delegateText;
  if (!text || !activeInstanceId) return;
  // Generate a topic-related label from the message text
  var label = text.substring(0, 30).replace(/[\n\r]/g, ' ').trim();
  if (text.length > 30) label += '...';
  // Create new session with the target agent
  window._pendingNewSession = { instanceId: activeInstanceId, agent: agentId, label: label, delegateText: text };
  send('create-session', { instanceId: activeInstanceId, agentId: agentId, label: label });
  toast('已委派给 ' + getAgentDef(agentId).name, 'success');
}

function closeDelegateModal() {
  var overlay = document.getElementById('delegate-overlay');
  if (overlay) { overlay.style.opacity='0'; setTimeout(function(){overlay.remove();},200); }
}

// ===== P2: Enhanced createSession with topic-based label =====
createSession = function() {
  if (!activeInstanceId) return;
  var aid = document.getElementById('ns-agent').value.trim() || 'main';
  var label = document.getElementById('ns-label').value.trim();
  // Auto-generate label from input if not provided
  if (!label) {
    var input = document.getElementById('msg-input').value.trim();
    if (input) {
      label = input.substring(0, 30).replace(/[\n\r]/g, ' ').trim();
      if (input.length > 30) label += '...';
    }
  }
  window._pendingNewSession = { instanceId: activeInstanceId, agent: aid, label: label };
  send('create-session', { instanceId: activeInstanceId, agentId: aid, label: label || undefined });
  closeNewSessionModal();
};

// Enhanced auto-select: when pending delegate, send the message after session is created

// ===== Utils =====
function esc(s) { if (typeof s!=='string') return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(ts) { if (!ts) return ''; var d=new Date(typeof ts==='number'?ts:ts); return d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}); }
function fmtRelative(ts) {
  if (!ts) return '';
  var d = new Date(typeof ts==='number'?ts:ts);
  var diff = Date.now() - d.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff/60000)+'分钟前';
  if (diff < 86400000) return Math.floor(diff/3600000)+'小时前';
  return fmtTime(ts);
}
function fmtDate(ts) { var d=new Date(typeof ts==='number'?ts:ts); var t=new Date(); if (d.toDateString()===t.toDateString()) return '今天'; var y=new Date(t); y.setDate(y.getDate()-1); if (d.toDateString()===y.toDateString()) return '昨天'; return d.toLocaleDateString('zh-CN',{month:'long',day:'numeric'}); }
function fmtBytes(b) { if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
function scrollToBottom() { var el=document.getElementById('messages'); requestAnimationFrame(function(){el.scrollTop=el.scrollHeight;}); }

// ===== Model Switcher =====
function switchModel() {
  if (!activeInstanceId) return;
  // Show loading state
  var el = document.getElementById('ch-model');
  el.textContent = '⏳ 加载中...';
  fetch(resolveUrl('/api/models/' + encodeURIComponent(activeInstanceId)))
    .then(function(r){ return r.json(); })
    .then(function(data){
      var models = data.models || [];
      // Also add current model if not in list
      var currentModel = '';
      var inst = instances.find(function(i){return i.id===activeInstanceId});
      var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
      if (sess && sess.messages) {
        for (var i=sess.messages.length-1;i>=0;i--) { if(sess.messages[i].model){currentModel=sess.messages[i].model;break;} }
      }
      if (currentModel && !models.some(function(m){return m.id===currentModel;})) {
        models.push({ id: currentModel, name: currentModel.split('/').pop(), provider: currentModel.split('/')[0] });
      }
      showModelDropdown(models, currentModel);
    })
    .catch(function(){
      // Fallback: collect from current session
      var models = [];
      var seen = {};
      var inst = instances.find(function(i){return i.id===activeInstanceId});
      var sess = inst ? inst.sessions.find(function(s){return s.key===activeSessionKey}) : null;
      if (sess && sess.messages) {
        sess.messages.forEach(function(m){
          if(m.model && !seen[m.model]){seen[m.model]=true;models.push({id:m.model,name:m.model.split('/').pop(),provider:m.model.split('/')[0]});}
        });
      }
      showModelDropdown(models, '');
    });
}
function showModelDropdown(models, currentModel) {
  // Remove existing dropdown
  var old = document.getElementById('model-dropdown');
  if (old) old.remove();
  if (models.length === 0) {
    // No models found, fall back to text input
    showModal({title:'🤖 切换模型',text:'输入模型名称',input:true,inputDefault:'',confirmText:'切换'}).then(function(v){
      if(v===null)return;var inp=document.getElementById('msg-input');inp.value='/model '+v.trim();sendMessage();
    });
    return;
  }
  // Group by provider
  var groups = {};
  models.forEach(function(m){
    var p = m.provider || 'other';
    if(!groups[p]) groups[p] = [];
    groups[p].push(m);
  });
  var html = '<div class="model-dropdown" id="model-dropdown">';
  html += '<div class="model-dropdown-header">🤖 选择模型</div>';
  html += '<div class="model-dropdown-list">';
  for (var prov in groups) {
    html += '<div class="model-group-label">' + esc(prov) + '</div>';
    groups[prov].forEach(function(m){
      var active = m.id === currentModel ? ' active' : '';
      html += '<div class="model-option' + active + '" data-model="' + esc(m.id) + '" onclick="selectModel(\'' + esc(m.id) + '\')">';
      html += '<span class="model-name">' + esc(m.name) + '</span>';
      if (active) html += '<span class="model-check">✓</span>';
      html += '</div>';
    });
  }
  html += '</div>';
  html += '<div class="model-dropdown-footer">';
  html += '<input id="model-custom-input" placeholder="或输入自定义模型 ID..." onkeydown="if(event.key===\'Enter\')selectModel(this.value)">';
  html += '<button onclick="selectModel(document.getElementById(\'model-custom-input\').value)">确定</button>';
  html += '</div>';
  html += '</div>';
  // Insert after model badge
  var el = document.getElementById('ch-model');
  el.insertAdjacentHTML('afterend', html);
  // Close on click outside
  setTimeout(function(){
    document.addEventListener('click', closeModelDropdown, { once: true });
  }, 50);
}
function closeModelDropdown(e) {
  var dd = document.getElementById('model-dropdown');
  if (dd && !dd.contains(e.target) && e.target.id !== 'ch-model') {
    dd.remove();
  } else if (dd) {
    document.addEventListener('click', closeModelDropdown, { once: true });
  }
}
function selectModel(modelId) {
  var dd = document.getElementById('model-dropdown');
  if (dd) dd.remove();
  if (!modelId || !modelId.trim()) return;
  var inp = document.getElementById('msg-input');
  inp.value = '/model ' + modelId.trim();
  sendMessage();
}
function updateModelBadge() {
  var el=document.getElementById('ch-model');
  if(!el) return;
  var inst=instances.find(function(i){return i.id===activeInstanceId});
  var sess=inst?inst.sessions.find(function(s){return s.key===activeSessionKey}):null;
  if(!sess||!sess.messages){el.style.display='none';return;}
  // Find last agent message with model info
  var model='';
  for(var i=sess.messages.length-1;i>=0;i--){var m=sess.messages[i];if(m.role==='assistant'&&m.model){model=m.model;break;}}
  if(model){
    // Shorten model name: "openrouter/xiaomi/mimo-v2-pro" → "mimo-v2-pro"
    var short=model.split('/').pop();
    el.textContent='🤖 '+short;
    el.title='模型: '+model+'\n点击切换';
    el.style.display='';
  } else {
    el.textContent='🤖 模型';
    el.title='点击设置模型';
    el.style.display='';
  }
}

function showAddInstance() { document.getElementById('m-name').value=''; document.getElementById('m-url').value=''; document.getElementById('m-token').value=''; document.getElementById('m-desc').value=''; document.getElementById('add-modal').classList.add('show'); document.getElementById('m-name').focus(); }
function closeAddModal() { document.getElementById('add-modal').classList.remove('show'); }
function showNewSessionModal() {
  if (!activeInstanceId) return;
  // Populate agent dropdown from AGENT_DEFS
  var sel = document.getElementById('ns-agent');
  sel.innerHTML = AGENT_DEFS.map(function(a){return '<option value="'+a.id+'"'+(a.id===activeAgentId?' selected':'')+'>'+a.emoji+' '+a.name+' ('+a.id+')</option>'}).join('');
  document.getElementById('ns-label').value='';
  document.getElementById('new-session-modal').classList.add('show');
}
function closeNewSessionModal() { document.getElementById('new-session-modal').classList.remove('show'); }

// ===== Exec Approval Dialog =====
function showApprovalDialog(instanceId, approval) {
  var overlay = document.getElementById('approval-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'approval-overlay';
    overlay.className = 'approval-overlay';
    document.body.appendChild(overlay);
  }
  var agentEmoji = { main: '🧠', search: '🔍', dev: '💻', monitor: '📡', quant: '📈' }[approval.agentId] || '🤖';
  overlay.innerHTML = '<div class="approval-dialog">' +
    '<div class="approval-header">🔐 命令执行审批</div>' +
    '<div class="approval-meta">' +
      '<div class="approval-row"><span class="approval-label">Agent</span><span class="approval-value">' + agentEmoji + ' ' + esc(approval.agentId) + '</span></div>' +
      (approval.cwd ? '<div class="approval-row"><span class="approval-label">目录</span><span class="approval-value">' + esc(approval.cwd) + '</span></div>' : '') +
    '</div>' +
    '<div class="approval-command"><pre>' + esc(approval.command) + '</pre></div>' +
    '<div class="approval-actions">' +
      '<button class="approval-btn deny" onclick="resolveApproval(\'' + esc(instanceId) + '\',\'' + esc(approval.id) + '\',\'deny\')">❌ 拒绝</button>' +
      '<button class="approval-btn allow-once" onclick="resolveApproval(\'' + esc(instanceId) + '\',\'' + esc(approval.id) + '\',\'allow-once\')">✅ 允许一次</button>' +
      '<button class="approval-btn allow-always" onclick="resolveApproval(\'' + esc(instanceId) + '\',\'' + esc(approval.id) + '\',\'allow-always\')">🔓 始终允许</button>' +
    '</div>' +
  '</div>';
  overlay.classList.add('show');
  // Store for cleanup
  overlay._approvalId = approval.id;
  // Play notification sound / vibrate
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
}

function hideApprovalDialog(approvalId) {
  var overlay = document.getElementById('approval-overlay');
  if (overlay && (!approvalId || overlay._approvalId === approvalId)) {
    overlay.classList.remove('show');
    setTimeout(function() { if (overlay.parentNode) overlay.innerHTML = ''; }, 300);
  }
}

function resolveApproval(instanceId, approvalId, decision) {
  send('resolve-approval', { instanceId: instanceId, approvalId: approvalId, decision: decision });
  hideApprovalDialog(approvalId);
  toast(decision === 'allow-once' ? '✅ 已允许一次' : decision === 'allow-always' ? '🔓 已始终允许' : '❌ 已拒绝', decision === 'deny' ? 'error' : 'success');
}
function toggleSessionPanel() { var panel = document.getElementById('session-panel'); var overlay = document.getElementById('sidebar-overlay'); var sidebarBtn = document.getElementById('sidebar-toggle-btn'); var svgClose = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>'; var svgOpen = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>'; if (window.matchMedia('(max-width:600px)').matches) { var opening = !panel.classList.contains('open'); panel.classList.toggle('open'); if (overlay) overlay.classList.toggle('show', opening); } else { var collapsed = !panel.classList.contains('collapsed'); panel.classList.toggle('collapsed'); if (sidebarBtn) { sidebarBtn.innerHTML = collapsed ? svgOpen : svgClose; sidebarBtn.title = collapsed ? '展开侧边栏' : '收起侧边栏'; } } }
function abortRun() { if (activeInstanceId&&activeSessionKey) { send('abort',{instanceId:activeInstanceId,sessionKey:activeSessionKey}); document.getElementById('abort-btn').classList.remove('running'); } }

function filterSessions() { var q=(document.getElementById('search-input').value||'').toLowerCase(); document.querySelectorAll('.session-item').forEach(function(el){var n=el.querySelector('.s-name');var p=el.querySelector('.s-preview');el.style.display=(!q||(n&&n.textContent.toLowerCase().indexOf(q)>=0)||(p&&p.textContent.toLowerCase().indexOf(q)>=0))?'':'none';}); }

function markUnread(instanceId, sessionKey) { if (instanceId===activeInstanceId && sessionKey===activeSessionKey) return; var key=instanceId+'/'+sessionKey; unreadSessions.set(key,(unreadSessions.get(key)||0)+1); renderAgents(); renderSessions(); }
function clearUnread(instanceId, sessionKey) { if (sessionKey) { unreadSessions.delete(instanceId+'/'+sessionKey); } else { unreadSessions.forEach(function(v,k){ if(k.startsWith(instanceId+'/')) unreadSessions.delete(k); }); } renderAgents(); renderSessions(); }
function clearAllUnread() {
  unreadSessions.clear();
  renderAgents(); renderSessions();
}
function updateMarkAllReadBtn() {
  var btn = document.getElementById('mark-all-read-btn');
  if (!btn) return;
  var hasUnread = unreadSessions.size > 0;
  btn.style.display = hasUnread ? '' : 'none';
  btn.textContent = '✓' + (hasUnread ? ' (' + unreadSessions.size + ')' : '');
  // Update unread summary in chat header
  var el = document.getElementById('ch-unread-summary');
  if (el) {
    if (hasUnread) {
      var totalMsgs = 0;
      unreadSessions.forEach(function(c){ totalMsgs += c; });
      el.textContent = '🔔 ' + unreadSessions.size + ' 会话 · ' + totalMsgs + ' 条未读';
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }
}

function focusNextUnread() {
  // Jump to the next unread session (prioritize current agent across ALL instances)
  if (unreadSessions.size === 0) return;
  var candidates = [];
  unreadSessions.forEach(function(count, key) {
    var iid = key.split('/')[0];
    var sk = key.substring(iid.length+1);
    var inst = instances.find(function(i){return i.id===iid});
    if (!inst) return;
    var sess = inst.sessions.find(function(s){return s.key===sk});
    var priority = 0;
    if (iid === activeInstanceId && sess && (sess.agent||'main') === activeAgentId) priority = 2; // same instance + agent
    else if (sess && (sess.agent||'main') === activeAgentId) priority = 1; // same agent different instance
    candidates.push({ key, iid, sk, priority, sess, inst });
  });
  candidates.sort(function(a,b){ return b.priority - a.priority; });
  if (candidates.length > 0) {
    var best = candidates[0];
    if (best.sess) selectAgent(best.sess.agent||'main');
    selectSession(best.iid, best.sk);
  }
}

function createSession() {
  if (!activeInstanceId) return;
  var aid=document.getElementById('ns-agent').value.trim()||'main';
  var label=document.getElementById('ns-label').value.trim();
  window._pendingNewSession = { instanceId: activeInstanceId, agent: aid, label: label };
  send('create-session',{instanceId:activeInstanceId,agentId:aid,label:label||undefined});
  closeNewSessionModal();
}

// ===== Context Menu =====
document.addEventListener('contextmenu',function(e){
  var icon=e.target.closest('.instance-icon');
  if(icon){e.preventDefault();instCtxTarget=icon.dataset.id;var menu=document.getElementById('inst-ctx-menu');menu.style.left=e.clientX+'px';menu.style.top=e.clientY+'px';menu.classList.add('show');return;}
  var item=e.target.closest('.session-item');
  if(item){e.preventDefault();var sInst=instances.find(function(i){return i.id===activeInstanceId});var sSess=sInst?sInst.sessions.find(function(s){return s.key===activeSessionKey}):null;var isPinned=sSess?sSess.pinned:false;ctxTarget={instanceId:activeInstanceId,sessionKey:activeSessionKey,pinned:isPinned};var pinBtn2=document.getElementById('ctx-pin-btn');if(pinBtn2)pinBtn2.textContent=isPinned?'取消置顶':'📌 置顶会话';var menu2=document.getElementById('ctx-menu');menu2.style.left=e.clientX+'px';menu2.style.top=e.clientY+'px';menu2.classList.add('show');}
});
document.addEventListener('click',function(e){if(!e.target.closest('.ctx-menu')){document.getElementById('ctx-menu').classList.remove('show');document.getElementById('inst-ctx-menu').classList.remove('show');}});
function openSessMenu(e,instanceId,sessionKey,pinned) {
  ctxTarget={instanceId:instanceId,sessionKey:sessionKey,pinned:pinned};
  var menu=document.getElementById('ctx-menu');
  var pinBtn=document.getElementById('ctx-pin-btn');
  if(pinBtn) pinBtn.textContent=pinned?'取消置顶':'📌 置顶会话';
  var rect=e.target.getBoundingClientRect();
  menu.style.left=rect.left+'px';
  menu.style.top=(rect.bottom+4)+'px';
  menu.classList.add('show');
}
function ctxAction(action) {
  if (!ctxTarget) return;
  document.getElementById('ctx-menu').classList.remove('show');
  if (action==='inject') {
    showModal({title:'注入消息',input:true,inputDefault:'',confirmText:'发送'}).then(function(t){if(t)send('inject-message',{instanceId:ctxTarget.instanceId,sessionKey:ctxTarget.sessionKey,text:t});});
  } else if (action==='delete') {
    showModal({title:'删除会话',text:'确定删除此会话？此操作不可撤销。',confirmText:'删除'}).then(function(ok){if(ok){send('delete-session',{instanceId:ctxTarget.instanceId,sessionKey:ctxTarget.sessionKey});toast('会话已删除','success');}});
  } else if (action==='rename') {
    var sInst=instances.find(function(i){return i.id===ctxTarget.instanceId});
    var sSess=sInst?sInst.sessions.find(function(s){return s.key===ctxTarget.sessionKey}):null;
    showModal({title:'重命名会话',input:true,inputDefault:sSess?sSess.name:'',confirmText:'保存'}).then(function(n){if(n&&n.trim()){send('rename-session',{instanceId:ctxTarget.instanceId,sessionKey:ctxTarget.sessionKey,name:n.trim()});toast('已重命名','success');}});
  } else if (action==='pin') {
    var isPinned=ctxTarget.pinned;
    send(isPinned?'unpin-session':'pin-session',{instanceId:ctxTarget.instanceId,sessionKey:ctxTarget.sessionKey});
    toast(isPinned?'已取消置顶':'已置顶','success');
  }
}

function instCtxAction(action) {
  if (!instCtxTarget) return;
  var inst=instances.find(function(i){return i.id===instCtxTarget});
  if(!inst) return;
  document.getElementById('inst-ctx-menu').classList.remove('show');
  if (action==='rename') {
    showModal({title:'重命名实例',input:true,inputDefault:inst.name,confirmText:'保存'}).then(function(n){if(n&&n.trim()&&n!==inst.name){send('rename-instance',{instanceId:inst.id,name:n.trim()});toast('已重命名','success');}});
  } else if (action==='editDesc') {
    showModal({title:'角色简介',input:true,inputDefault:inst.desc||'',confirmText:'保存'}).then(function(d){if(d!==null){send('rename-instance',{instanceId:inst.id,desc:d});toast('已更新','success');}});
  } else if (action==='delete') {
    showModal({title:'删除实例',text:'确定删除实例 "'+inst.name+'" ？此操作不可撤销。',confirmText:'删除'}).then(function(ok){if(ok){send('remove-instance',{instanceId:inst.id});toast('实例已删除','success');}});
  }
}

function editInstanceDesc() {
  if(!activeInstanceId) return;
  var inst=instances.find(function(i){return i.id===activeInstanceId});
  if(!inst) return;
  showModal({title:'角色简介',input:true,inputDefault:inst.desc||'',confirmText:'保存'}).then(function(d){if(d!==null){send('rename-instance',{instanceId:inst.id,desc:d});toast('已更新','success');}});
}

function quickRenameInstance(id) {
  var inst=instances.find(function(i){return i.id===id});
  if(!inst) return;
  showModal({title:'重命名实例',input:true,inputDefault:inst.name,confirmText:'保存'}).then(function(n){if(n&&n.trim()&&n!==inst.name){send('rename-instance',{instanceId:inst.id,name:n.trim()});toast('已重命名','success');}});
}

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown',function(e){
  if (e.key==='Escape') { closeAddModal(); closeNewSessionModal(); closeLightbox(); hideCmdPalette(); document.getElementById('ctx-menu').classList.remove('show'); document.getElementById('inst-ctx-menu').classList.remove('show'); document.querySelectorAll('.react-bar').forEach(function(b){b.style.display='none';}); var si=document.getElementById('chat-search'); if(si===document.activeElement&&si.value){si.value='';applySearch();si.blur();} }
  if ((e.ctrlKey&&e.key==='k')||(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&document.activeElement.tagName!=='INPUT'&&document.activeElement.tagName!=='TEXTAREA')) { e.preventDefault(); var si=document.getElementById('search-input'); document.getElementById('session-search').style.display='block'; si.focus(); si.select(); }
  // Ctrl+/: focus input with / prefix (command palette)
  if (e.ctrlKey&&e.key==='/') { e.preventDefault(); var inp=document.getElementById('msg-input'); inp.focus(); inp.value='/'; inp.dispatchEvent(new Event('input')); }
  if (e.ctrlKey&&e.key==='n') { e.preventDefault(); showNewSessionModal(); }
  if (e.ctrlKey&&e.key==='r') { e.preventDefault(); refreshSessions(); }
  // Ctrl+Shift+C = copy last message
  if (e.ctrlKey&&e.shiftKey&&e.key==='C') {
    e.preventDefault();
    var msgs = document.querySelectorAll('.msg');
    if (msgs.length > 0) {
      var lastMsg = msgs[msgs.length - 1];
      var copyBtn = lastMsg.querySelector('.msg-actions button');
      if (copyBtn) copyMsg(copyBtn);
    }
  }
  // F3 or Ctrl+G = next search match
  if (e.key==='F3'||(e.ctrlKey&&e.key==='g')) { e.preventDefault(); scrollToSearchMatch(1); }
  // Shift+F3 or Ctrl+Shift+G = prev search match
  if (e.key==='F3'&&e.shiftKey||(e.ctrlKey&&e.shiftKey&&e.key==='G')) { e.preventDefault(); scrollToSearchMatch(-1); }
  // Enter in search = next match
  if (e.key==='Enter'&&document.activeElement===document.getElementById('chat-search')) { e.preventDefault(); scrollToSearchMatch(e.shiftKey?-1:1); }
  // Ctrl+1-9: switch session by index
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    var inst = instances.find(function(i){return i.id===activeInstanceId});
    if (inst && inst.sessions[parseInt(e.key)-1]) {
      selectSession(activeInstanceId, inst.sessions[parseInt(e.key)-1].key);
    }
  }
  // Ctrl+?: show shortcuts help
  if (e.ctrlKey && e.key === '?') {
    e.preventDefault();
    showModal({title:'⌨️ 快捷键',text:'Ctrl+N 新建会话\nCtrl+K 搜索会话\nCtrl+R 刷新\nCtrl+1-9 切换会话\nCtrl+Shift+C 复制最后消息\nF3/Ctrl+G 搜索下一个\nCtrl+/ 命令面板\nEscape 关闭弹窗',confirmText:'知道了',cancelText:''});
  }
});

// ===== Agent Manager =====
let _editingAgentId = null;

function openAgentManager() {
  _editingAgentId = null;
  renderAgentManagerModal();
  document.getElementById('agent-manager-modal').classList.add('show');
}

function closeAgentManager() {
  document.getElementById('agent-manager-modal').classList.remove('show');
  _editingAgentId = null;
}

function renderAgentManagerModal() {
  var list = document.getElementById('agent-manager-list');
  if (!list) return;
  list.innerHTML = AGENT_DEFS.map(function(a) {
    return '<div class="am-row" data-id="' + a.id + '">' +
      '<span class="am-emoji">' + a.emoji + '</span>' +
      '<span class="am-name" style="color:' + a.color + '">' + esc(a.name) + '</span>' +
      '<span class="am-id">' + a.id + '</span>' +
      '<span class="am-actions">' +
        '<button class="am-btn am-edit" onclick="showEditAgent(\'' + a.id + '\')" title="编辑">✏️</button>' +
        '<button class="am-btn am-del" onclick="removeAgentConfirm(\'' + a.id + '\')" title="删除">🗑️</button>' +
      '</span>' +
    '</div>';
  }).join('');

  // Show add/edit form
  var form = document.getElementById('agent-manager-form');
  if (_editingAgentId) {
    var agent = AGENT_DEFS.find(function(a){return a.id===_editingAgentId});
    if (agent) {
      document.getElementById('amf-title').textContent = '编辑 Agent';
      document.getElementById('amf-id').value = agent.id;
      document.getElementById('amf-id').disabled = false;
      document.getElementById('amf-name').value = agent.name;
      document.getElementById('amf-emoji').value = agent.emoji;
      document.getElementById('amf-color').value = agent.color;
      document.getElementById('amf-color-text').value = agent.color;
      document.getElementById('amf-original-id').value = agent.id;
      document.getElementById('amf-submit').textContent = '保存';
    }
    form.style.display = '';
  } else {
    document.getElementById('amf-title').textContent = '添加 Agent';
    document.getElementById('amf-id').value = '';
    document.getElementById('amf-id').disabled = false;
    document.getElementById('amf-name').value = '';
    document.getElementById('amf-emoji').value = '💬';
    document.getElementById('amf-color').value = '#6b7280';
    document.getElementById('amf-color-text').value = '#6b7280';
    document.getElementById('amf-original-id').value = '';
    document.getElementById('amf-submit').textContent = '添加';
    form.style.display = '';
  }
}

function showEditAgent(id) {
  _editingAgentId = id;
  renderAgentManagerModal();
}

function showAddAgent() {
  _editingAgentId = null;
  renderAgentManagerModal();
}

function removeAgentConfirm(id) {
  showModal({title:'删除 Agent',text:'确定删除 Agent "' + id + '" ？已有的会话不受影响，但无法再新建该 Agent 的会话。',confirmText:'删除'}).then(function(ok){
    if(ok){ send('remove-agent',{id:id}); toast('Agent 已删除','success'); }
  });
}

function submitAgentForm() {
  var id = document.getElementById('amf-id').value.trim();
  var name = document.getElementById('amf-name').value.trim();
  var emoji = document.getElementById('amf-emoji').value.trim();
  var color = document.getElementById('amf-color-text').value.trim() || document.getElementById('amf-color').value.trim();
  var originalId = document.getElementById('amf-original-id').value.trim();

  if (!id) return alert('Agent ID 必填');
  if (!name) return alert('名称必填');

  if (originalId) {
    // Edit
    var data = { id: originalId, name: name, emoji: emoji, color: color };
    if (id !== originalId) data.newId = id;
    send('update-agent', data);
    toast('Agent 已更新','success');
  } else {
    // Add
    if (AGENT_DEFS.find(function(a){return a.id===id})) {
      return alert('Agent ID "' + id + '" 已存在');
    }
    send('add-agent', { id: id, name: name, emoji: emoji, color: color });
    toast('Agent 已添加','success');
  }
  _editingAgentId = null;
  renderAgentManagerModal();
}

// ===== Server Setup (Android/Tauri) =====
function showServerSetup() {
  var modal = document.getElementById('server-setup-modal');
  if (modal) {
    var input = document.getElementById('setup-server-url');
    if (input) input.value = getServerUrl() || 'http://192.168.1.48:19800';
    modal.classList.add('show');
  }
}

function saveServerSetup() {
  var input = document.getElementById('setup-server-url');
  var url = (input && input.value.trim()) || '';
  if (!url) return alert('请输入服务器地址');
  // Normalize: remove trailing slash
  url = url.replace(/\/+$/, '');
  // Ensure protocol
  if (!/^https?:\/\//.test(url)) url = 'http://' + url;
  localStorage.setItem('oc-server-url', url);
  var modal = document.getElementById('server-setup-modal');
  if (modal) modal.classList.remove('show');
  // Reconnect with new URL
  if (panelWs) { panelWs.close(); panelWs = null; }
  connectPanel();
}

// ===== Init =====
window._editFromIdx = -1;
connectPanel();

