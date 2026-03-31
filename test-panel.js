#!/usr/bin/env node
// Comprehensive panel feature test against Docker instance
const WebSocket = require('ws');

const PASS = '\x1b[32m✅ PASS\x1b[0m';
const FAIL = '\x1b[31m❌ FAIL\x1b[0m';
const WARN = '\x1b[33m⚠️  WARN\x1b[0m';

const results = [];
function test(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? PASS : FAIL} ${name}${detail ? ' — ' + detail : ''}`);
}
function warn(name, detail) {
  results.push({ name, ok: 'warn', detail });
  console.log(`${WARN} ${name}${detail ? ' — ' + detail : ''}`);
}

const ws = new WebSocket('ws://localhost:19800/panel-ws');
let step = 'connect';
let dockerSessionKey = null;
let historyMsgs = [];
let wsMessages = [];

ws.on('open', () => {
  test('WS 连接', true);
  step = 'wait-state';
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  wsMessages.push(msg);

  if (msg.type === 'full-state' && step === 'wait-state') {
    step = 'state-received';
    
    // Test 1: Full state structure
    test('full-state 收到', !!msg.instances, `instances: ${msg.instances?.length}`);
    test('时间戳存在', !!msg.ts, msg.ts ? new Date(msg.ts).toISOString() : 'missing');
    
    // Test 2: Docker instance
    const docker = msg.instances?.find(i => i.id === 'docker-01');
    test('Docker 实例在线', docker?.status === 'online', docker?.status);
    test('Docker 有会话', docker?.sessions?.length > 0, `${docker?.sessions?.length} sessions`);
    
    // Test 3: Local instance
    const local = msg.instances?.find(i => i.id === 'local');
    test('Local 实例在线', local?.status === 'online', local?.status);
    test('Local 有会话', local?.sessions?.length > 0, `${local?.sessions?.length} sessions`);
    
    // Test 4: Session structure
    const sess = docker?.sessions?.[0];
    if (sess) {
      test('会话有 key', !!sess.key);
      test('会话有 name', !!sess.name);
      test('会话有 messageCount', typeof sess.messageCount === 'number', `${sess.messageCount} msgs`);
      dockerSessionKey = sess.key;
      
      // Load history
      ws.send(JSON.stringify({ type: 'load-history', instanceId: 'docker-01', sessionKey: sess.key }));
      step = 'wait-history';
    }
  }

  if (msg.type === 'history' && step === 'wait-history') {
    step = 'history-received';
    historyMsgs = msg.messages || [];
    
    test('历史加载', true, `${historyMsgs.length} messages`);
    test('历史有 sessionKey', msg.sessionKey === dockerSessionKey);
    
    // Test message structure
    if (historyMsgs.length > 0) {
      const m = historyMsgs[0];
      test('消息有 role', !!m.role, m.role);
      test('消息有 content', m.content !== undefined, typeof m.content);
      test('消息有 ts', typeof m.ts === 'number', new Date(m.ts).toISOString());
    }
    
    // Test: Check for duplicate user messages
    let dups = 0;
    for (let i = 1; i < historyMsgs.length; i++) {
      const prev = historyMsgs[i-1], curr = historyMsgs[i];
      if (prev.role === 'user' && curr.role === 'user') {
        const t1 = typeof prev.content === 'string' ? prev.content : (prev.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
        const t2 = typeof curr.content === 'string' ? curr.content : (curr.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
        if (t1 === t2 && t1.length > 0) dups++;
      }
    }
    test('无重复用户消息', dups === 0, dups > 0 ? `${dups} duplicates` : 'clean');
    
    // Test: Structured content parsing
    const structuredMsgs = historyMsgs.filter(m => Array.isArray(m.content));
    test('结构化消息可解析', structuredMsgs.length > 0, `${structuredMsgs.length} structured`);
    
    // Test: Thinking parts
    const thinkingMsgs = historyMsgs.filter(m => Array.isArray(m.content) && m.content.some(p => p.type === 'thinking'));
    if (thinkingMsgs.length > 0) {
      test('思考过程数据存在', true, `${thinkingMsgs.length} messages with thinking`);
    } else {
      warn('无思考过程数据', '需人工确认是否有 thinking 内容');
    }
    
    // Test: Image parts
    const imageMsgs = historyMsgs.filter(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
    if (imageMsgs.length > 0) {
      test('图片数据存在', true, `${imageMsgs.length} images`);
    }
    
    // Test: Tool parts
    const toolMsgs = historyMsgs.filter(m => Array.isArray(m.content) && m.content.some(p => p.type === 'toolCall' || p.type === 'toolResult'));
    if (toolMsgs.length > 0) {
      test('工具调用数据存在', true, `${toolMsgs.length} messages with tools`);
    }

    // Now send a test message
    console.log('\n--- 发送消息测试 ---');
    ws.send(JSON.stringify({
      type: 'send-message',
      instanceId: 'docker-01',
      sessionKey: dockerSessionKey,
      text: '面板自动化测试：请回复"TEST_OK"'
    }));
    step = 'wait-response';
  }

  if (msg.type === 'message' && step === 'wait-response') {
    const m = msg.message;
    wsMessages.push({ _type: 'received-message', role: m.role, ts: m.ts });
    
    if (m.role === 'user') {
      test('用户消息广播', true, `role=${m.role}`);
      // Check format
      const isString = typeof m.content === 'string';
      const isStructured = Array.isArray(m.content);
      test('用户消息格式', isString || isStructured, isString ? 'string' : 'structured');
    }
    
    if (m.role !== 'user') {
      test('Agent 回复', true, `role=${m.role}`);
      if (Array.isArray(m.content)) {
        const types = m.content.map(p => p.type).join('+');
        test('回复有文本', m.content.some(p => p.type === 'text'), types);
      }
      // Check for model/usage
      if (m.model) test('回复有 model', true, m.model);
      else warn('回复无 model', '可能还未完成');
      step = 'response-received';
    }
  }

  if (msg.type === 'run-status') {
    if (msg.status === 'running') test('Run 状态: running', true);
    if (msg.status === 'done') test('Run 状态: done', true);
    if (msg.status === 'error') test('Run 状态: error', false, msg.error || '');
  }

  // Test: After response, check dedup
  if (step === 'response-received') {
    step = 'checking-dedup';
    setTimeout(() => {
      console.log('\n--- 去重验证 ---');
      // Reload history
      ws.send(JSON.stringify({ type: 'load-history', instanceId: 'docker-01', sessionKey: dockerSessionKey }));
      step = 'dedup-check';
    }, 2000);
  }

  if (msg.type === 'history' && step === 'dedup-check') {
    const newMsgs = msg.messages || [];
    const newCount = newMsgs.length;
    const oldCount = historyMsgs.length;
    test('消息数合理增长', newCount > oldCount, `${oldCount} → ${newCount}`);
    
    // Check for consecutive duplicate user messages
    let dups = 0;
    for (let i = 1; i < newMsgs.length; i++) {
      const prev = newMsgs[i-1], curr = newMsgs[i];
      if (prev.role === 'user' && curr.role === 'user') {
        const t1 = typeof prev.content === 'string' ? prev.content : (prev.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
        const t2 = typeof curr.content === 'string' ? curr.content : (curr.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
        if (t1 === t2 && t1.length > 0) {
          dups++;
          console.log(`  重复: [${i-1}]"${t1.substring(0,40)}" vs [${i}]"${t2.substring(0,40)}"`);
        }
      }
    }
    test('发送后无重复用户消息', dups === 0, dups > 0 ? `${dups} dups` : 'clean');
    
    // Test: Static file serving
    step = 'done';
    finishTests();
  }
});

ws.on('error', (e) => { test('WS 连接', false, e.message); process.exit(1); });

function finishTests() {
  console.log('\n===============================');
  const passed = results.filter(r => r.ok === true).length;
  const failed = results.filter(r => r.ok === false).length;
  const warned = results.filter(r => r.ok === 'warn').length;
  console.log(`总计: ${results.length} | ${PASS}: ${passed} | ${FAIL}: ${failed} | ${WARN}: ${warned}`);
  
  if (failed > 0) {
    console.log('\n❌ 失败项:');
    results.filter(r => r.ok === false).forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
  if (warned > 0) {
    console.log('\n⚠️  警告项:');
    results.filter(r => r.ok === 'warn').forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
  
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

setTimeout(() => { console.log('\n⏰ 超时'); finishTests(); }, 25000);
