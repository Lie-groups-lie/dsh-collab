// Native DSH lazy browser module. React is supplied by DSH, not bundled twice.
window.__ModuleLoader__.load({ id: 'dsh-codex-collab', factory(require) {
  const React = require('react');
  const { createElement: h, useState, useEffect, useRef } = React;
  const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
  const markdownLabels = { code: { copyLabel: '复制代码', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' } }, footnotes: '脚注' };
  const PANEL = 'dsh-collab';
  const statusLabel = (value) => {
    const state = typeof value === 'string' ? value : typeof value?.kind === 'string' ? value.kind : '';
    return ({ idle: '空闲', active: '已启用', inactive: '未启用', delivered: '已投递', 'not-confirmed': '尚未确认投递', 'removed-by-native': '原生计划已移除', ready: '可继续', 'not-started': '尚未执行', admitted: '已准入', 'delivered-awaiting-admission': '已投递，等待准入', unavailable: '会话不可用', canceled: '已取消', cancelled: '已取消', stopped: '已停止', answered: '已返回答案', interrupted: '本轮已中断，续接前核验', abandoned: '已中止并结算（非成功）', expired: '授权窗口已过期', settled: '已结算', completed: '已完成', accepted: '续接已提交', finalizing: '整理结果中', blocked: '尚未完成：需要处理阻碍', running: '运行中', pending: '已提交', unknown: '中断待核验（续接时自动检查）', failed: '失败', 'max-tokens': '单次响应被截断' })[state] || state || '待核对';
  };
  const busy = (task) => task.running || ['pending', 'running', 'unknown'].includes(task.submission?.state);
  async function request(operation, args, signal) {
    const response = await fetch(new URL('api/dsh-collab', document.baseURI), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, arguments: args }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  class Observer {
    constructor(api = request) { this.api = api; this.generation = 0; this.state = { tasks: [], total: 0, nextOffset: null, error: '', loading: false }; }
    async load({ append = false, archived = false, background = false } = {}) {
      if (append && (this.state.loading || this.state.nextOffset == null) || background && this.state.loading) return;
      const reset = this.archived !== archived;
      this.archived = archived;
      const generation = ++this.generation;
      this.controller?.abort(); this.controller = new AbortController();
      this.state = { ...this.state, loading: true }; this.changed?.();
      try {
        const page = await this.api('deepseek_tasks_list', { limit: 50, offset: append ? this.state.nextOffset || 0 : 0, include_archived: archived }, this.controller.signal);
        if (generation !== this.generation) return;
        // Refresh the head without discarding already-read history or opening folders.
        const previous = reset ? [] : this.state.tasks;
        const anchor = previous.findIndex(task => task.sessionId === page.tasks.at(-1)?.sessionId);
        const tail = !append && page.nextOffset != null && anchor >= 0 ? previous.slice(anchor + 1).filter(task => !page.tasks.some(item => item.sessionId === task.sessionId)) : [];
        const tasks = append ? [...new Map([...previous, ...page.tasks].map((task) => [task.sessionId, task])).values()] : [...page.tasks, ...tail];
        // Cursor counts server records, not deduplicated rendered rows. If the head
        // has no shared anchor, start a fresh window rather than skipping unknown rows.
        const next = page.nextOffset == null ? null : page.nextOffset + (append ? 0 : tail.length);
        this.state = { tasks, total: page.total, nextOffset: next != null && next < page.total ? next : null, error: '', loading: false };
      } catch (error) {
        if (generation !== this.generation) return;
        this.state = { ...this.state, loading: false, error: `查询失败，保留上次记录：${error.message}` };
      }
      this.changed?.();
    }
    pause() { this.generation++; this.controller?.abort(); this.state = { ...this.state, loading: false }; }
    dispose() { this.pause(); this.changed = null; }
  }
  function autoRefresh(observer, { archived = false, doc = document, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer, stopped = false;
    const refresh = async () => {
      if (stopped || doc.hidden) return;
      await observer.load({ archived, background: true });
      if (!stopped && !doc.hidden) timer = setTimer(refresh,
        !observer.state.error && observer.state.tasks.some(busy) ? 8000 : 30000);
    };
    const visibility = () => {
      clearTimer(timer);
      if (doc.hidden) observer.pause();
      else void refresh();
    };
    doc.addEventListener('visibilitychange', visibility);
    void refresh();
    return () => { stopped = true; clearTimer(timer); observer.pause(); doc.removeEventListener('visibilitychange', visibility); };
  }
  // Both readers retain the last successful content on errors and reject late responses.
  class ResultReader {
    constructor(sessionId, api = request) { this.sessionId = sessionId; this.api = api; this.generation = 0; this.state = { result: null, loading: false, error: '' }; }
    async load(append = false) {
      if (this.state.loading || append && this.state.result?.nextOffset == null) return;
      const generation = ++this.generation, before = this.state.result;
      this.controller = new AbortController(); this.state = { ...this.state, loading: true, error: '' }; this.changed?.();
      try {
        const result = await this.api('deepseek_task_result', { session_id: this.sessionId, include_task: !append, limit: 12000,
          offset: append ? before.nextOffset : 0, ...(append ? { expected_turn: before.turnId, ...(before.revision ? { expected_revision: before.revision } : {}) } : {}) }, this.controller.signal);
        if (generation !== this.generation) return;
        if (append && (result.turnId !== before.turnId || result.revision !== before.revision)) throw new Error('结果已更新，请刷新详情后继续阅读。');
        this.state = { result: append ? { ...before, ...result, text: before.text + result.text } : result, loading: false, error: '' };
      } catch (error) {
        if (generation !== this.generation) return;
        this.state = { ...this.state, loading: false, error: `读取失败，已保留当前内容：${error.message}` };
      }
      this.changed?.();
    }
    dispose() { this.generation++; this.controller?.abort(); this.state = { ...this.state, loading: false }; this.changed = null; }
  }
  class ReportReader {
    constructor(channel, api = request) { this.channel = channel; this.api = api; this.generation = 0; this.state = { data: null, loading: false, error: '' }; }
    async load() {
      if (this.state.loading) return;
      const generation = ++this.generation, before = this.state.data;
      this.controller = new AbortController(); this.state = { ...this.state, loading: true, error: '' }; this.changed?.();
      try {
        const page = await this.api('deepseek_notifications', { channel: this.channel, consumer: 'ui', after_seq: before?.nextCursor || 0, limit: 20 }, this.controller.signal);
        if (generation !== this.generation) return;
        const events = [...new Map([...(before?.events || []), ...page.events].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
        // Retention matches the host. Bound memory even when a channel stays open for days.
        this.state = { data: { ...page, events: events.slice(-256), gap: page.gap || before?.gap,
          clipped: before?.clipped || events.length > 256 }, loading: false, error: '' };
      } catch (error) {
        if (generation !== this.generation) return;
        this.state = { ...this.state, loading: false, error: `查询失败，已保留当前汇报：${error.message}` };
      }
      this.changed?.();
    }
    dispose() { this.generation++; this.controller?.abort(); this.state = { ...this.state, loading: false }; this.changed = null; }
  }
  class TraceReader {
    constructor(sessionId, api = request) { this.sessionId = sessionId; this.api = api; this.generation = 0; this.state = { data: null, loading: false, error: '' }; }
    async load(append = false) {
      const before = this.state.data;
      if (this.state.loading || append && before?.nextBeforeSeq == null) return;
      const generation = ++this.generation;
      this.controller = new AbortController(); this.state = { ...this.state, loading: true, error: '' }; this.changed?.();
      try {
        const page = await this.api('deepseek_task_trace', { session_id: this.sessionId, max_messages: 12,
          ...(append ? { before_seq: before.nextBeforeSeq, through_seq: before.throughSeq } : {}) }, this.controller.signal);
        if (generation !== this.generation) return;
        if (append && page.throughSeq !== before.throughSeq) throw new Error('会话记录边界已变化，请刷新过程。');
        const items = [...new Map([...(append ? before.items : []), ...page.items].map(item => [item.seq, item])).values()].sort((a, b) => b.seq - a.seq);
        this.state = { data: { ...page, items: items.slice(-500), windowed: append && before.windowed || items.length > 500 }, loading: false, error: '' };
      } catch (error) {
        if (generation !== this.generation) return;
        this.state = { ...this.state, loading: false, error: `过程读取失败，已保留内容：${error.message}` };
      }
      this.changed?.();
    }
    dispose() { this.generation++; this.controller?.abort(); this.changed = null; this.state = { ...this.state, loading: false }; }
  }
  // One read on entering the viewport, then only on further user scroll/keyboard input.
  // Do not refire on each render: collapsed folders must not drain the entire archive.
  function connectScrollTail(node, read, { ObserverType = IntersectionObserver, doc = document } = {}) {
    const root = node.closest('.dsh-collab');
    const near = () => node.getBoundingClientRect().top <= root.getBoundingClientRect().bottom + 180;
    const proceed = () => { if (!doc.hidden && near()) read(); };
    const observer = new ObserverType(entries => { if (entries.some(entry => entry.isIntersecting)) proceed(); }, { root, rootMargin: '180px' });
    const wheel = e => { if (e.deltaY > 0) proceed(); };
    const key = e => { if (['End', 'PageDown', 'ArrowDown'].includes(e.key) && !/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '')) proceed(); };
    observer.observe(node); root.addEventListener('scroll', proceed, { passive: true }); root.addEventListener('wheel', wheel, { passive: true }); root.addEventListener('keydown', key);
    return () => { observer.disconnect(); root.removeEventListener('scroll', proceed); root.removeEventListener('wheel', wheel); root.removeEventListener('keydown', key); };
  }
  function ScrollTail({ more, loading, error, load, retry, label = '内容' }) {
    const node = useRef(null), current = useRef(null);
    current.current = () => { if (more && !loading && !error) load(); };
    useEffect(() => connectScrollTail(node.current, () => current.current()), []);
    return h('div', { className: 'scroll-tail', ref: node, tabIndex: more ? 0 : -1, 'aria-live': 'polite' },
      loading ? `正在读取${label}…` : error ? h('button', { onClick: retry || load }, '重试读取') : more ? '向下滚动继续阅读' : `已显示全部${label}`);
  }
  const css = `
    .dsh-collab{--line:color-mix(in srgb,currentColor 12%,transparent);--wash:color-mix(in srgb,currentColor 4%,transparent);height:100%;overflow:auto;scrollbar-gutter:stable;padding:var(--dsh-frame-top-clearance,28px) clamp(18px,4vw,64px) 32px;color:inherit;background:inherit;font:inherit;box-sizing:border-box;overscroll-behavior:contain}
    .dsh-collab *{box-sizing:border-box}.dsh-collab h1{font-size:24px;font-weight:600;letter-spacing:-.6px;margin:0}.dsh-collab h2{font-size:15px;font-weight:600;margin:0 0 12px}
    .dsh-collab header,.dsh-collab .toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:22px}.dsh-collab header{padding-top:8px}
    .dsh-collab .muted{opacity:.58;font-size:12px}.dsh-collab .grow{flex:1;min-width:0}.dsh-collab .subtitle{margin:7px 0 0;line-height:1.5}
    .dsh-collab button,.dsh-collab input,.dsh-collab select{font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px 11px}
    .dsh-collab button{cursor:pointer}.dsh-collab button:hover{background:var(--wash)}.dsh-collab button:disabled{opacity:.4;cursor:default}.dsh-collab .ghost{border-color:transparent}
    .dsh-collab :is(button,input,select,[tabindex]):focus-visible{outline:2px solid #7185d6;outline-offset:2px}.dsh-collab input[type=checkbox]{accent-color:#7481a7;width:14px;height:14px;flex:none}
    .dsh-collab .toolbar input[type=search]{flex:1;min-width:180px;background:var(--wash);border-color:transparent}.dsh-collab .toolbar label{display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap}
    .dsh-collab .workspace{border-bottom:1px solid var(--line);padding:7px 0}.dsh-collab .workspace-head{border:0;width:100%;display:flex;align-items:center;text-align:left;gap:12px;padding:13px 10px}
    .dsh-collab .workspace-name{display:block;font-weight:600;font-size:14px}.dsh-collab .workspace-path{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.48}
    .dsh-collab .count{font-size:11px;border:1px solid var(--line);border-radius:6px;padding:2px 7px;opacity:.65}.dsh-collab .chevron{width:12px;opacity:.5}
    .dsh-collab .row{display:flex;align-items:center;gap:12px;padding:7px 10px 7px 30px;border-radius:8px;content-visibility:auto;contain-intrinsic-size:auto 64px}.dsh-collab .row:hover{background:var(--wash)}
    .dsh-collab .row .task{flex:1;text-align:left;border:0;min-width:0;padding:9px 0}.dsh-collab .task span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-collab .task .muted{margin-top:5px;font-size:11px}
    .dsh-collab .status{font-size:11px;border-radius:5px;padding:4px 7px;white-space:nowrap;background:var(--wash);opacity:.7}.dsh-collab .status[data-busy=true]{color:#879cdd;opacity:1}.dsh-collab .more{border:0;font-size:18px;padding:3px 9px}
    .dsh-collab .notice{border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--wash);font-size:12px;margin:12px 0;overflow-wrap:anywhere}
    .dsh-collab .detail{display:grid;grid-template-columns:minmax(0,1fr) 252px;gap:32px}.dsh-collab pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:1.85;margin:0;tab-size:2}.dsh-collab .answer{padding:8px 0 24px}
    .dsh-collab .tabs{display:flex;gap:20px;margin-bottom:22px;border-bottom:1px solid var(--line);flex-wrap:wrap}.dsh-collab .tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:10px 2px;opacity:.5}.dsh-collab .tabs [aria-selected=true]{border-bottom-color:currentColor;opacity:1}
    .dsh-collab aside{align-self:start;border-left:1px solid var(--line);padding-left:22px;font-size:12px}.dsh-collab aside pre{font-size:11px}
    .dsh-collab dl{margin:0 0 22px}.dsh-collab dl div{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
    .dsh-collab dt{opacity:.55}.dsh-collab dd{margin:0;text-align:right;overflow-wrap:anywhere}.dsh-collab summary{cursor:pointer;opacity:.6;margin:12px 0;font-size:12px}
    .dsh-collab .menu{position:fixed;z-index:1000;min-width:205px;max-width:calc(100vw - 16px);background:Canvas;color:CanvasText;border:1px solid #8884;border-radius:10px;padding:5px;box-shadow:0 12px 35px #0003}
    .dsh-collab .menu button{display:block;width:100%;text-align:left;border:0;padding:9px 10px}.dsh-collab .empty{padding:65px 24px;text-align:center;opacity:.55;font-size:13px}
    .dsh-collab .scroll-tail{padding:24px 12px;text-align:center;font-size:11px;opacity:.5;min-height:62px}.dsh-collab .report{border-left:1px solid var(--line);padding:0 0 26px 22px;margin-left:5px;content-visibility:auto;contain-intrinsic-size:auto 200px}.dsh-collab .report-heading{font-size:12px;display:flex;gap:12px;align-items:center;margin-bottom:14px}
    .dsh-collab .report .row{padding:10px 0;align-items:start}.dsh-collab .report pre{font-size:12px}.dsh-collab .report-body{padding:14px 18px;border:1px solid var(--line);border-radius:10px}.dsh-collab .report-id{font-size:11px;overflow-wrap:anywhere;opacity:.5}.dsh-collab .report-preview{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
    .dsh-collab details[open] .report-preview{display:block}.dsh-collab .report-list{margin-top:28px}.dsh-collab .selection{padding:9px 12px;border:1px solid var(--line);border-radius:9px;display:flex;align-items:center;gap:12px;margin-bottom:16px;font-size:12px}
    .dsh-collab .trace-entry{border-left:2px solid var(--line);padding:4px 0 18px 18px;margin:0 0 14px;content-visibility:auto;contain-intrinsic-size:auto 160px}.dsh-collab .trace-entry summary{opacity:1;line-height:1.6}.dsh-collab .trace-meta{display:block;font-size:11px;opacity:.55;margin-top:4px}.dsh-collab .trace-entry pre{font-size:12px;max-height:65vh;overflow:auto;padding:12px;background:var(--wash);border-radius:8px}.dsh-collab .trace-entry[data-error=true]{border-left-color:#b37575}.dsh-collab .child-links{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
    .dsh-collab .info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:16px;margin:16px 0 24px}.dsh-collab .info-card{padding:18px;border:1px solid var(--line);border-radius:12px;min-width:0}.dsh-collab .info-card dl{margin:0}.dsh-collab .info-card dd{max-width:65%}.dsh-collab .chips{display:flex;flex-wrap:wrap;gap:6px}.dsh-collab .chip{padding:3px 8px;background:var(--wash);border-radius:5px;overflow-wrap:anywhere}.dsh-collab .breadcrumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:12px 0}.dsh-collab .breadcrumb button{max-width:100%;text-align:left;overflow-wrap:anywhere}.dsh-collab .cache-meter{width:100%;height:8px;accent-color:#879cdd;margin:6px 0 14px}.dsh-collab .timeline{list-style:none;margin:0;padding:0}.dsh-collab .timeline li{padding:8px 0 18px 16px;border-left:2px solid var(--line);line-height:1.7}.dsh-collab .timeline time{display:block;font-size:11px;opacity:.6}.dsh-collab .trace-fields{margin:10px 0}.dsh-collab .trace-fields dd{text-align:left;max-width:75%}.dsh-collab h3{font-size:14px;font-weight:600}.dsh-collab .role-label{font-size:11px;opacity:.6;margin-right:8px}
    @media(max-width:950px){.dsh-collab{padding-left:18px;padding-right:18px}.dsh-collab .detail{grid-template-columns:1fr}.dsh-collab aside{border-left:0;border-top:1px solid var(--line);padding:20px 0}.dsh-collab .row{padding-left:12px}.dsh-collab .toolbar{gap:8px}.dsh-collab .toolbar input[type=search]{flex-basis:100%}}
  `;
  const conversationStyle = `
    .dsh-collab .conversation{font-size:var(--dsh-content-font-size,14px);line-height:1.7;color:var(--dsw-alias-label-primary,inherit)}
    .dsh-collab .conversation-turn{margin:0 0 30px;min-width:0}.dsh-collab .turn-heading{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary,#888);font-size:12px;margin:18px 0}.dsh-collab .turn-heading:after{content:'';height:1px;background:var(--line);flex:1}
    .dsh-collab .conversation .trace-entry{border:0;padding:0;margin:12px 0 24px;min-width:0;content-visibility:auto;contain-intrinsic-size:auto 130px}
    .dsh-collab .message-user{display:flex;flex-direction:column;align-items:flex-end}.dsh-collab .message-user .message-body{max-width:82%;background:var(--dsw-specific-bubble,var(--wash));border-radius:var(--dsw-radius-xl,18px);padding:10px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
    .dsh-collab .message-assistant .message-body{padding:4px 0;min-width:0}.dsh-collab .message-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);margin-bottom:7px}.dsh-collab .message-meta summary{font-size:11px;margin:8px 0}
    .dsh-collab .native-markdown{min-width:0;overflow-wrap:anywhere}.dsh-collab .native-markdown button{padding:0;border:0;background:transparent}.dsh-collab .native-markdown pre{font-family:var(--ds-font-family-code,monospace);font-size:12px;max-width:100%;overflow:auto;white-space:pre;line-height:1.6;padding:12px;background:var(--wash)}.dsh-collab .native-markdown table{display:block;max-width:100%;overflow:auto}.dsh-collab .native-markdown img{max-width:100%}
    .dsh-collab .tool-exchange,.dsh-collab .process-event{border:1px solid var(--line);border-radius:var(--dsw-radius-lg,12px);padding:0 14px;margin:10px 0;background:var(--dsw-alias-bg-base,transparent)}.dsh-collab .tool-exchange>summary,.dsh-collab .process-event>summary{opacity:1;font-size:13px;margin:10px 0;line-height:1.6;overflow-wrap:anywhere}.dsh-collab .tool-exchange[data-error=true],.dsh-collab .process-event[data-error=true]{border-color:var(--dsw-alias-state-error-primary,#b37575)}
    .dsh-collab .tool-exchange .trace-entry{margin:12px 0}.dsh-collab .tool-exchange pre{max-height:50vh;overflow:auto}.dsh-collab .readonly-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);margin:0 0 18px}.dsh-collab .policy-summary{margin-top:22px}.dsh-collab .policy-summary summary{opacity:1}.dsh-collab .trace-outline .trace-entry{margin-bottom:14px}
  `;
  function NativeText({ text }) {
    // The shipped Chat uses this same session-independent renderer. No Session,
    // composer, fork, retry, submission or mutation service is mounted here.
    return h('div', { className: 'native-markdown', 'data-renderer': typeof MarkdownText === 'function' || typeof MarkdownText === 'object' ? 'dsh' : 'plain' },
      MarkdownText && text.length <= 100000 ? h(MarkdownText, { text, streaming: false, labels: markdownLabels }) : h('pre', null, text));
  }
  function conversationGroups(items = []) {
    const groups = new Map(); let currentTurn;
    for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
      if (item.turn != null) currentTurn = item.turn;
      const key = currentTurn ?? 'unknown';
      if (!groups.has(key)) groups.set(key, { turn: currentTurn, maxSeq: item.seq, rows: [], calls: new Map() });
      const group = groups.get(key); group.maxSeq = item.seq;
      if (item.type === 'tool/call' && item.callId) {
        const row = { kind: 'tool', key: item.seq, items: [item] }; group.rows.push(row); group.calls.set(item.callId, row);
      } else if (item.type === 'tool/result' && item.callId && group.calls.has(item.callId)) {
        group.calls.get(item.callId).items.push(item);
      } else group.rows.push({ kind: 'event', key: item.seq, items: [item] });
    }
    return [...groups.values()].sort((a, b) => b.maxSeq - a.maxSeq).map(({ calls, ...group }) => group);
  }
  const treeStyle = '.dsh-collab .lineage-list{list-style:none;padding:0;margin:0}.dsh-collab .lineage-node{margin:12px 0 12px calc(var(--depth)*18px);border-left:2px solid var(--line);padding:4px 16px 10px;content-visibility:auto;contain-intrinsic-size:auto 130px}.dsh-collab .lineage-node[data-selected=true]{border-left-color:#879cdd;background:var(--wash)}.dsh-collab .lineage-node .row{padding:0}.dsh-collab .lineage-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;opacity:.65}.dsh-collab .identity{font-family:monospace;font-size:11px;word-break:break-all}.dsh-collab .lineage-node strong{font-weight:500}';
  const json = (value) => JSON.stringify(value ?? {}, null, 2);
  const roleLabel = role => ({ lead: '主任务 · Lead', child: '子任务', direct: '独立任务', relay: '工作区中转' })[role] || '任务';
  const titleFor = task => task?.title && task.title !== task.sessionId ? task.title : `未命名${roleLabel(task?.role).split(' · ')[0]}`;
  const permissionLabel = value => ({ 'read-only': '只读', 'workspace-write': '可修改工作区', custom: '自定义权限' })[value] || value || '未提供';
  const yesNo = value => value === true ? '允许' : value === false ? '禁止' : '未提供';
  const limitLabel = value => value === null || value === -1 ? '未设上限' : Number.isFinite(value) ? value.toLocaleString() : '未提供';
  const dateLabel = value => value != null && Number.isFinite(new Date(value).getTime()) ? `${new Date(value).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` : '未提供';
  const reasonLabel = value => ({ 'native-inbox-not-empty': '还有待处理消息', 'native-session-archived': '会话或父会话已归档', 'Occurrence exceeded maximum delivery lateness': '投递延迟超过授权范围', 'Execution authorization window expired': '执行授权窗口已过期', 'Previous Lead execution is unknown; no automatic replay': '上一轮结果未知，需要先核验，不会自动重跑' })[value] || value || '未提供';
  function Fields({ rows }) {
    return h('dl', null, rows.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value ?? '未提供'))));
  }
  function Policy({ result }) {
    if (!result) return h('p', null, '正在读取策略…');
    const policy = result.effectivePolicy || {}, child = policy.childPolicy, budget = result.budgetPolicy || {};
    const tools = p => p.maxToolCalls === 0 ? '禁止调用工具' : Array.isArray(p.allowedTools)
      ? p.allowedTools.length ? h('span', { className: 'chips' }, p.allowedTools.map(name => h('span', { className: 'chip', key: name }, name))) : '未授权工具'
      : p.allowedTools === null ? '按原生工具集与权限筛选' : '未提供工具清单';
    const executionRows = p => [ ['模型', p.model || '未提供'], ['推理强度', ({ off: '关闭', low: '低', high: '高', max: '最高' })[p.reasoningEffort] || p.reasoningEffort || '未提供'],
      ['文件权限', permissionLabel(p.permission)], ['终端命令', yesNo(p.allowTerminal)], ['外部写入', yesNo(p.allowExternalWrites)], ['可用工具', tools(p)], ['每轮工具次数', limitLabel(p.maxToolCalls)], ['单次输出 tokens', limitLabel(p.maxOutputTokens)] ];
    return h('section', { role: 'tabpanel', 'aria-label': '策略' },
      h('p', { className: 'muted' }, '当前任务与未来子任务分别授权。共享预算约束整棵任务树；实际工具还需通过原生权限与插件准入检查。'),
      result.warnings?.length > 0 && h('div', { className: 'notice', role: 'status' }, result.warnings.map((warning, i) => h('p', { key: `${warning.code}-${i}` }, warning.message))),
      h(Fields, { rows: [ ['本轮派发工具', result.delegation?.enabled == null ? '等待本轮工具清单确认' : yesNo(result.delegation.enabled)], ['策略允许派发', yesNo(result.delegation?.policyAllows)], ['子任务数量上限（不代表已授权）', limitLabel(result.delegation?.maxChildren)], ['消息回传工具', result.messaging?.enabled == null ? '尚未观察到本轮请求' : yesNo(result.messaging.enabled)] ] }),
      h('div', { className: 'info-grid' }, h('article', { className: 'info-card' }, h('h2', null, '当前任务'), h(Fields, { rows: executionRows(policy) })),
        h('article', { className: 'info-card' }, h('h2', null, '未来子任务'), child ? h(Fields, { rows: executionRows(child) }) : h('p', { className: 'muted' }, '没有提供独立的子任务策略，不能据此推断其权限。')),
        h('article', { className: 'info-card' }, h('h2', null, '整棵任务树的预算'), h(Fields, { rows: [ ['累计请求', limitLabel(budget.maxRequests)], ['累计输入 tokens', limitLabel(budget.maxTotalInputTokens)], ['累计输出 tokens', limitLabel(budget.maxTotalOutputTokens)], ['累计工具调用', limitLabel(budget.maxTotalToolCalls)], ['总子任务数', limitLabel(budget.maxChildrenTotal)], ['实际截止时间', result.effectiveDeadline?.iso ? dateLabel(result.effectiveDeadline.iso) : result.effectiveDeadline ? '未设置' : '未提供'] ] }))),
      result.recovery && h('p', { className: 'notice' }, `恢复状态：${statusLabel(result.recovery.state)} · 保留 ${result.recovery.preservedSessions?.length || 0} 个子任务。`),
      result.recoveryHolds?.length > 0 && h('p', { className: 'notice' }, '仍有恢复保留额度，不能视为可用预算；请展开审计信息核对。'),
      h(RawDetails, { label: '策略原始字段与恢复审计', value: { effectivePolicy: result.effectivePolicy, budgetPolicy: result.budgetPolicy, effectiveDeadline: result.effectiveDeadline, recovery: result.recovery, reconciliation: result.reconciliation, recoveryHolds: result.recoveryHolds } }));
  }
  function ToolBody({ text, type }) {
    let value;
    if (type === 'tool/call' && text && text.length < 32000) { try { value = JSON.parse(text); } catch {} }
    if (!value || Array.isArray(value) || typeof value !== 'object') return h('pre', null, text || '此阶段没有文本内容。');
    const labels = { file_path: '文件', path: '路径', pattern: '匹配内容', query: '查询', command: '命令', description: '任务说明', prompt: '子任务要求', content: '写入内容', old_string: '原内容', new_string: '替换内容' };
    return h('div', { className: 'trace-fields' }, h(Fields, { rows: Object.entries(value).slice(0, 20).map(([key, v]) => [labels[key] || key, typeof v === 'object' ? json(v) : String(v)]) }), h(RawDetails, { label: '完整工具参数', value }));
  }
  const folderName = value => value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value;
  function RawDetails({ value, label = '原始数据' }) {
    const [open, setOpen] = useState(false);
    return h('details', { onToggle: e => setOpen(e.currentTarget.open) }, h('summary', null, label), open && h('pre', null, json(value)));
  }
  // Iterative traversal is safe for deeply nested or damaged legacy lineage.
  function treeRows(nodes, collapsed = new Set()) {
    const byId = new Map(nodes.map(n => [n.sessionId, n])), children = new Map(), visited = new Set(), result = [];
    for (const node of nodes) { const list = children.get(node.parentSessionId) || []; list.push(node); children.set(node.parentSessionId, list); }
    const walk = start => {
      const stack = [{ node: start, depth: 0 }];
      while (stack.length) {
        const { node, depth } = stack.pop(); if (visited.has(node.sessionId)) continue;
        visited.add(node.sessionId); result.push({ node, depth });
        if (collapsed.has(node.sessionId)) {
          const hidden = [...(children.get(node.sessionId) || [])];
          while (hidden.length) {
            const child = hidden.pop(); if (visited.has(child.sessionId)) continue;
            visited.add(child.sessionId); hidden.push(...(children.get(child.sessionId) || []));
          }
        } else for (const child of (children.get(node.sessionId) || []).slice().reverse()) stack.push({ node: child, depth: depth + 1 });
      }
    };
    nodes.filter(n => !byId.has(n.parentSessionId)).forEach(walk);
    nodes.forEach(n => { if (!visited.has(n.sessionId)) walk(n); });
    return result;
  }
  function TaskTree({ sessionId, api, openTask }) {
    const [data, setData] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
    const [loadingMore, setLoadingMore] = useState(false);
    const [collapsed, setCollapsed] = useState(() => new Set());
    const generation = useRef(0);
    useEffect(() => {
      generation.current++;
      const controller = new AbortController(); setError(''); setLoadingMore(false);
      api('deepseek_task_tree', { session_id: sessionId }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setData(value); })
        .catch(e => { if (!controller.signal.aborted) setError(e.message); });
      return () => { controller.abort(); generation.current++; };
    }, [sessionId, api, refresh]);
    async function moreReceipts() {
      if (loadingMore || data?.nextReceiptOffset == null) return;
      setLoadingMore(true);
      const current = generation.current;
      try {
        const next = await api('deepseek_task_tree', { session_id: sessionId, receipt_offset: data.nextReceiptOffset });
        if (current !== generation.current) return;
        if (next.receiptTotal !== data.receiptTotal) throw new Error('轮次已更新，请刷新任务树后读取历史。');
        setData(old => ({ ...old, receipts: [...old.receipts, ...next.receipts], nextReceiptOffset: next.nextReceiptOffset }));
      } catch (e) { if (current === generation.current) setError(e.message); } finally { if (current === generation.current) setLoadingMore(false); }
    }
    const parents = new Set((data?.edges || []).map(edge => edge.parent));
    function toggle(id) { setCollapsed(before => { const next = new Set(before); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
    return h('section', { className: 'task-tree', 'aria-label': '任务树' },
      h('style', null, treeStyle),
      h('div', { className: 'toolbar' }, h('p', { className: 'grow muted' }, data
        ? `${data.summary.total} 个节点 · ${data.summary.running} 运行中 · ${data.summary.unresolved} 回执待结算 · ${data.summary.settled} 已结算`
        : '正在读取整棵任务树…'), h('button', { onClick: () => setRefresh(n => n + 1) }, '刷新任务树')),
      h('p', { className: 'muted' }, '包含已归档子任务。运行状态与回执结算分别显示；已结算不代表执行成功。点击任务查看输入、过程和结果。'),
      error && h('p', { className: 'notice', role: 'alert' }, `读取失败，保留上次记录：${error}`),
      data?.warnings?.length > 0 && h('div', { className: 'notice' }, '部分节点的原生会话或关系无法确认，未将它们视为完成。', h('ul', null, data.warnings.map((w, i) => h('li', { key: i }, ({ ROOT_MISSING: '共享预算的根任务记录缺失', LINEAGE_CYCLE: '任务关系存在循环，需要核验', NATIVE_SESSION_UNAVAILABLE: '任务有回执，但原生会话暂不可读取' })[w.code] || '存在未确认的关系记录'))), h(RawDetails, { value: data.warnings, label: '关系核验详情' })),
      data && h('div', { className: 'info-grid' }, [ ['当前任务', data.selectedId], ['共享预算根任务', data.rootId], ['直接父任务', data.nodes.find(n => n.sessionId === data.selectedId)?.parentSessionId] ].map(([label, id]) => {
        const node = data.nodes.find(n => n.sessionId === id);
        return h('article', { className: 'info-card', key: label }, h('h2', null, label), node ? h('button', { className: 'ghost', onClick: () => openTask(node) }, titleFor(node)) : h('p', { className: 'muted' }, id ? '本树之外的父会话' : '没有上级任务'), id && !node && h(RawDetails, { label: '会话标识', value: { sessionId: id } }));
      })),
      h('ol', { className: 'lineage-list' }, treeRows(data?.nodes || [], collapsed).map(({ node, depth }) => h('li', { key: node.sessionId, className: 'lineage-node', 'data-selected': node.sessionId === sessionId, style: { '--depth': Math.min(depth, 8) } },
        h('div', { className: 'row' }, parents.has(node.sessionId) && h('button', { className: 'ghost', 'aria-expanded': !collapsed.has(node.sessionId), 'aria-label': `${collapsed.has(node.sessionId) ? '展开' : '收起'} ${titleFor(node)} 的子任务`, onClick: () => toggle(node.sessionId) }, collapsed.has(node.sessionId) ? '▸' : '▾'), h('button', { className: 'task', onClick: () => openTask(node) }, h('strong', null, titleFor(node)),
          h('span', { className: 'muted' }, `${roleLabel(node.role)} · 第 ${node.turn ?? '未知'} 轮${node.archived ? ' · 已归档' : ''}${node.sessionId === sessionId ? ' · 当前查看' : ''}`)),
          h('span', { className: 'status', 'data-busy': node.running === true }, statusLabel(node.state))),
        h('div', { className: 'lineage-meta' }, h('span', null, `回执：${node.submission?.state ? statusLabel(node.submission.state) : '未提供'}`),
          node.recovery && h('span', null, `恢复：${statusLabel(node.recovery.state)} · 保留 ${node.recovery.preservedSessions?.length || 0} 个子任务`)),
        node.admission?.blocked && h('p', { className: 'notice' }, node.admission.message),
        h('details', null, h('summary', null, '身份与回执'), h('dl', null, [ ['会话', node.sessionId], ['父任务', node.parentSessionId || '根任务'],
          ['原生父会话', node.nativeParentSessionId || '无'], ['共享预算根', node.rootId], ['本轮回执', node.submission?.id || '旧记录未提供'] ].map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', { className: 'identity' }, value)))))))),
      data && h('section', { className: 'receipt-history' }, h('h3', null, '当前任务的轮次与回执'),
        h('p', { className: 'muted' }, '新版本开始保留回执快照。更早的执行仍可在「过程」查看；缺失的构建身份不会补造。'),
        data.receipts?.map((receipt, index) => h('details', { key: `${receipt.id}:${receipt.turn}:${index}` },
          h('summary', null, `第 ${receipt.turn ?? '待开始'} 轮 · ${statusLabel(receipt.state)}${receipt.outcome ? ` · ${statusLabel(receipt.outcome)}` : ''}`),
          h('dl', null, [ ['回执 ID', receipt.id], ['恢复 ID', receipt.recoveryId || '无'], ['执行构建', receipt.executionBuild?.buildId || '旧记录未提供'],
            ['执行实例', receipt.executionBuild?.instanceId || '旧记录未提供'] ].map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', { className: 'identity' }, value)))))),
        data.nextReceiptOffset != null && h('button', { disabled: loadingMore, onClick: moreReceipts }, loadingMore ? '读取中…' : '展开更早轮次'),
        h(RawDetails, { label: '当前查询实例与构建', value: { build: data.runtimeBuild, instance: data.processInstance } })),
      data && h('p', { className: 'muted' }, `核验时间 ${new Date(data.observedAt).toLocaleString()} · 查询不会唤醒 Agent`));
  }
  function Metrics({ result, detail }) {
    const usage = result?.usage;
    const number = (value) => usage?.available && Number.isFinite(value) ? value.toLocaleString() : '未提供';
    const rows = [ ['模型', detail?.model || '未提供'], ['权限', permissionLabel(detail?.permission)],
      ['缓存命中率', usage?.available && Number.isFinite(usage.cacheHitRate) ? `${(usage.cacheHitRate * 100).toFixed(1)}%` : '未提供'],
      ['未缓存输入', number(usage?.uncachedInputTokens)], ['缓存读取', number(usage?.cacheReadTokens)],
      ['缓存写入', number(usage?.cacheWriteTokens)], ['累计输出', number(usage?.outputTokens)],
      ['本次响应推理', number(usage?.reasoningTokens)], ['本次可见输出', number(usage?.visibleOutputTokens)],
      ['终止原因', statusLabel(detail?.finishReason)], ['收尾', result?.finalization?.status || '无'],
      ['实际截止时间', result?.effectiveDeadline?.iso ? dateLabel(result.effectiveDeadline.iso) : result?.effectiveDeadline ? '未设置' : '未提供'] ];
    return h('aside', null, h('h2', null, '用量与执行状态'), usage?.available && Number.isFinite(usage.cacheHitRate) && usage.cacheHitRate >= 0 && usage.cacheHitRate <= 1 && h('meter', { className: 'cache-meter', min: 0, max: 1, value: usage.cacheHitRate, 'aria-label': '输入缓存命中率' }), h('dl', null, rows.map(([name, value]) => h('div', { key: name }, h('dt', null, name), h('dd', null, value)))),
      h('details', { className: 'policy-summary' }, h('summary', null, '当前任务与子任务策略'), h(Fields, { rows: [ ['当前终端', yesNo(result?.effectivePolicy?.allowTerminal)], ['当前工具额度', limitLabel(result?.effectivePolicy?.maxToolCalls)], ['子任务模型', result?.effectivePolicy?.childPolicy?.model], ['子任务权限', permissionLabel(result?.effectivePolicy?.childPolicy?.permission)], ['子任务终端', yesNo(result?.effectivePolicy?.childPolicy?.allowTerminal)], ['共享输出额度', limitLabel(result?.budgetPolicy?.maxTotalOutputTokens)] ] })),
      result?.error && h('div', { className: 'notice' }, result.error),
      result?.diagnostic && h(RawDetails, { label: '原生错误诊断（不含对话正文）', value: result.diagnostic }),
      h('p', { className: 'muted' }, '输入与累计输出按会话统计；推理/可见输出按最新响应。缺失用量不记成零。'),
      h(RawDetails, { label: '查看原始指标', value: { usage, finalization: result?.finalization } }),
      h('p', { className: 'muted' }, '此页仅查询，不会唤醒父会话。使用「刷新详情」读取最新状态。'));
  }
  function TraceEntry({ item, sessionId, throughSeq, api, outline = false, nested = false }) {
    const [body, setBody] = useState(item), [loading, setLoading] = useState(false), [error, setError] = useState('');
    const [expanded, setExpanded] = useState(false);
    async function more() {
      if (loading || body.nextOffset == null) return;
      setLoading(true); setError('');
      try {
        const page = await api('deepseek_task_trace', { session_id: sessionId, event_seq: item.seq, through_seq: throughSeq, offset: body.nextOffset, limit: 24000 });
        const next = page.items[0];
        if (next?.seq !== item.seq || next.offset !== body.nextOffset) throw new Error('记录发生变化，请刷新');
        setBody({ ...next, text: body.text + next.text });
      } catch (e) { setError(e.message); } finally { setLoading(false); }
    }
    const message = ['assistant/message', 'assistant/attempt', 'user/message'].includes(item.type), user = item.type === 'user/message';
    const metadata = h('details', { className: 'message-meta' }, h('summary', null, '记录详情'), h(Fields, { rows: [ ['记录序号', item.seq], ['时间', dateLabel(item.time)], ['轮次', item.turn], ['步骤', item.step], ['调用标识', item.callId], ['来源', item.source] ] }));
    const content = () => h(React.Fragment, null,
      h('div', { className: 'message-body' }, message ? user ? body.text : h(NativeText, { text: body.text || '没有可见文本。' }) : h(ToolBody, { text: body.text, type: body.type })),
      body.nextOffset != null && h('button', { disabled: loading, onClick: more }, loading ? '读取中…' : `继续读取此条记录（已读 ${body.text.length.toLocaleString()} / ${body.totalChars.toLocaleString()} 字符）`),
      error && h('div', { className: 'notice' }, error), metadata);
    const label = user ? '任务要求' : item.type === 'assistant/message' ? 'DeepSeek' : item.label;
    if (message && !outline || nested) return h('article', { className: `trace-entry ${user ? 'message-user' : message ? 'message-assistant' : ''}`, 'data-error': item.isError, 'data-seq': item.seq }, h('div', { className: 'message-label' }, label), content());
    return h('details', { className: 'trace-entry process-event', 'data-error': item.isError, 'data-seq': item.seq, onToggle: e => setExpanded(e.currentTarget.open) },
      h('summary', null, `${label}${item.name ? ` · ${item.name}` : ''}${item.isError ? ' · 失败' : ''}`, outline && message && h('span', { className: 'trace-meta' }, (item.text || '').split('\n')[0].replace(/[*`#]/g, '').slice(0, 100))), expanded && content());
  }
  function ToolExchange({ row, ...props }) {
    const [expanded, setExpanded] = useState(false), call = row.items[0], result = row.items.find(i => i.type === 'tool/result');
    return h('details', { className: 'tool-exchange', 'data-error': row.items.some(i => i.isError), onToggle: e => setExpanded(e.currentTarget.open) },
      h('summary', null, `工具调用 · ${call.name || '工具'} · ${result ? result.isError ? '返回错误' : '已返回' : '结果不在当前读取窗口'}`),
      expanded && row.items.map(item => h(TraceEntry, { ...props, key: item.seq, item, nested: true })));
  }
  function Trace({ reader, sessionId, api, openTask, outline = false }) {
    const { data, loading, error } = reader.state;
    return h('section', { className: `conversation${outline ? ' trace-outline' : ''}`, role: 'tabpanel', 'aria-label': outline ? '轨迹' : '过程' },
      h('style', null, conversationStyle),
      h('p', { className: 'muted' }, '最近轮次在前，轮内按执行顺序阅读。向下读取更早过程；工具详情按需展开。'),
      data?.windowed && h('div', { className: 'notice' }, '当前显示 500 条历史窗口；刷新可回到最新记录，原始日志未删除。'),
      data?.children?.length > 0 && h('div', { className: 'child-links' }, data.children.map(child => h('button', { key: child.sessionId, onClick: () => openTask?.(child) }, `${child.running ? '运行中' : '子任务'} · ${child.title}`))),
      conversationGroups(data?.items).map(group => h('section', { className: 'conversation-turn', key: group.turn ?? 'unknown' }, h('div', { className: 'turn-heading' }, group.turn == null ? '当前窗口未提供轮次' : `第 ${group.turn} 轮`),
        group.rows.map(row => row.kind === 'tool' ? h(ToolExchange, { key: `${data.throughSeq}:${row.key}`, row, sessionId, throughSeq: data.throughSeq, api }) : h(TraceEntry, { key: `${data.throughSeq}:${row.key}`, item: row.items[0], sessionId, throughSeq: data.throughSeq, api, outline })))),
      error && h('div', { className: 'notice', role: 'alert' }, error),
      !loading && data && !data.items.length && h('p', null, '当前读取窗口没有可展示的执行记录；请继续向下读取或检查任务状态。'),
      h(ScrollTail, { more: data?.nextBeforeSeq != null, loading, error, load: () => reader.load(true), retry: () => reader.load(), label: 'DSH 保留的过程记录' }));
  }
  function Schedules({ sessionId, api }) {
    const [data, setData] = useState(null), [error, setError] = useState(''), [detail, setDetail] = useState(null);
    useEffect(() => {
      const controller = new AbortController();
      api('deepseek_schedule_list', { lead_id: sessionId, limit: 100 }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setData(value); })
        .catch(e => { if (!controller.signal.aborted) setError(e.message); });
      return () => controller.abort();
    }, [sessionId, api]);
    return h('section', null, h('p', { className: 'muted' }, '创建成功 ≠ 已投递 ≠ 实验成功。过期和结果未知的旧计划不会自动补跑。'),
      error && h('p', { role: 'alert' }, error), !data && !error && h('p', null, '读取原生调度…'),
      data?.schedules.map(item => h('article', { className: 'workspace', key: item.scheduleId },
        h('h3', null, item.title),
        h('p', null, `计划：${statusLabel(item.state)} · 执行：${statusLabel(item.executionState)}`),
        item.execution?.delayMs != null && h('p', null, `准入延迟：${Math.round(item.execution.delayMs / 1000)} 秒`),
        h(Fields, { rows: [ ['计划投递时间', dateLabel(item.native?.scheduledAt || item.execution?.scheduledAt)], ['实际投递时间', dateLabel(item.native?.lastDelivery?.deliveredAt)], ['投递状态', statusLabel(item.deliveryState)], ['执行截止时间', dateLabel(item.window?.expiresAt)] ] }),
        item.execution?.reason && h('p', { className: 'notice' }, reasonLabel(item.execution.reason)),
        h('button', { onClick: async () => {
          try { setDetail(await api('deepseek_schedule_history', { lead_id: sessionId, schedule_id: item.scheduleId, limit: 20 })); }
          catch (e) { setError(e.message); }
        } }, '查看投递与执行回执'))),
      data && !data.schedules.length && h('p', null, '此 Lead 没有 Collab 原生计划。'),
      detail && h('section', { className: 'schedule-history' }, h('h3', null, '投递与执行记录'),
        h('ol', { className: 'timeline' }, (detail.executions || []).map((entry, i) => h('li', { key: i }, h('time', null, dateLabel(entry.scheduledAt || entry.at)), h('strong', null, statusLabel(entry.state)), entry.reason && h('p', null, reasonLabel(entry.reason)), entry.modelStarted === false && h('p', { className: 'muted' }, '未启动模型')))),
        !detail.executions?.length && h('p', { className: 'muted' }, '暂无已保存的执行记录。原生投递记录可在详情中核对。'), h(RawDetails, { label: '原生投递与执行审计', value: detail })));
  }
  function EvidencePanel({ sessionId, api, recovery = false }) {
    const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
    const [paths, setPaths] = useState(''), [revision, setRevision] = useState(0), [requestedPaths, setRequestedPaths] = useState([]);
    const [message, setMessage] = useState('');
    useEffect(() => {
      const controller = new AbortController(); setLoading(true); setError('');
      api(recovery ? 'deepseek_recovery_preview' : 'deepseek_task_evidence', { session_id: sessionId,
        ...(!recovery && requestedPaths.length ? { artifact_paths: requestedPaths } : {}) }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setData(value); })
        .catch(e => { if (!controller.signal.aborted) setError(`读取失败，保留上次记录：${e.message}`); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
      return () => controller.abort();
    }, [sessionId, recovery, revision, requestedPaths]);
    const download = () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `collab-${recovery ? 'recovery-preview' : 'evidence'}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const tasks = (title, rows) => h('section', { className: 'info-card' }, h('h3', null, `${title} · ${rows.length}`),
      rows.length ? h('ul', null, rows.map((row, i) => h('li', { key: row.sessionId || i }, row.title || row.name || '未命名任务')))
        : h('p', { className: 'muted' }, '无'));
    return h('section', { 'aria-label': recovery ? '恢复预演' : '交付证据' },
      h('h2', null, recovery ? '恢复前，先核对保留的工作' : '交付证据'),
      h('p', { className: 'muted' }, recovery ? '只检查当前记录。不启动模型，不重跑子任务，不清空费用。'
        : '汇总当前任务树回执、可见结果摘要和共享用量。模型结束与交付验收分别记录。'),
      h('div', { className: 'toolbar' }, h('button', { disabled: loading, onClick: () => setRevision(n => n + 1) }, loading ? '读取中…' : '重新核对'),
        h('button', { disabled: !data || loading || !!error, onClick: download }, '下载证据 JSON')),
      error && h('p', { role: 'alert', className: 'notice' }, error),
      message && h('p', { role: 'status', className: 'notice' }, message),
      data && (recovery ? h('div', null,
        h('p', { className: 'notice' }, ({ blocked: '暂不能准备续接，请核对阻碍。', 'verification-required': '存在结果未知的操作，需要核验副作用。',
          'ready-to-prepare': '可以准备原会话续接；不会自动启动任务。', 'no-recovery-needed': '当前没有需要恢复的中断回执。' })[data.state] || data.state),
        h('div', { className: 'info-grid' }, tasks('保留的已结算任务', data.preserved), tasks('中断的回执', data.interrupted), tasks('保留的失败记录', data.failures)),
        h('p', null, `待核验操作 ${data.uncertainSideEffects.length} 项 · 可重新读取 ${data.retryableReads.length} 项`),
        h('p', null, `有效截止：${data.deadline?.at ? dateLabel(data.deadline.at) : '无已配置期限'}`),
        data.blockers.length > 0 && h('ul', { className: 'notice' }, data.blockers.map((item, i) => h('li', { key: i },
          ({ 'native-inbox-not-empty': '原会话仍有待处理消息。', 'native-agent-not-idle': '原生 Agent 尚未空闲。',
            'live-dispatch': '任务仍有活动派发。', 'native-inspection-unavailable': '暂时无法核对原生会话。',
            'shared-or-scheduled-deadline-expired': '共享任务或计划授权期限已过。', 'task-changed-during-preview': '读取期间任务记录有变化，请重新核对。' })[item.reason]
            || '存在其他准入阻碍，请展开审计字段核对。'))),
        h('ol', null, h('li', null, '读取并复用已完成分支的成果。'), h('li', null, '核验未知写入或其他副作用，不自动重试。'),
          h('li', null, '准备恢复后，由调用方向同一会话提交剩余工作；仍须通过权限、预算和期限检查。')),
        h('button', { disabled: loading || !!error || !data.canPrepare || !data.interrupted.length, onClick: async () => {
          setLoading(true); setMessage('');
          try {
            const receipt = await api('deepseek_task_reconcile', { session_id: sessionId, action: 'recover', expected_digest: data.expectedDigest,
              request_key: crypto.randomUUID(), reason: 'User explicitly prepared recovery after reviewing the read-only preview' });
            setMessage(`已准备续接，保留 ${receipt.preservedSessions.length} 个已结算任务。没有启动模型，请由调用方向原会话提交继续指令。`);
            setRevision(n => n + 1);
          } catch (e) { setError(e.message); } finally { setLoading(false); }
        } }, '准备原会话续接（不启动模型）')) : h('div', null,
        h('div', { className: 'info-grid' }, h('section', { className: 'info-card' }, h('h3', null, '执行状态'),
          h('p', null, ({ running: '仍在运行', settled: '回执已结算', 'needs-attention': '需要核验' })[data.executionState])),
          h('section', { className: 'info-card' }, h('h3', null, '交付验收'), h('p', null, '尚未验证'), h('p', { className: 'muted' }, '本页不会执行测试或判断答案正确。'))),
        h('p', null, `覆盖 ${data.coverage.includedTasks} / ${data.coverage.totalTasks} 个任务 · 已保留结果 ${data.summary.retainedOutputs} 份 · 文件哈希 ${data.summary.hashedArtifacts} / ${data.summary.requestedArtifacts}`),
        (!data.stable || data.warnings.length > 0) && h('p', { className: 'notice' }, '记录有变化或覆盖不完整，请展开详情核对后重新读取。'),
        h('label', null, '可选：核对当前工作区文件（每行一个相对路径，使用 /）',
          h('textarea', { value: paths, rows: 3, style: { display: 'block', width: '100%', boxSizing: 'border-box' }, onChange: e => setPaths(e.target.value), placeholder: 'reports/result.json' })),
        h('button', { disabled: loading, onClick: () => { setRequestedPaths([...new Set(paths.split(/\r?\n/).map(p => p.trim()).filter(Boolean))]); } }, '读取并计算哈希'),
        h('p', { className: 'muted' }, '只读取明确指定的文件，不扫描目录。哈希反映当前文件，不证明由哪个任务生成；导出不含文件正文。'),
        data.artifacts.map(row => h('p', { key: row.path }, `${row.path} · ${({ hashed: '已计算哈希', missing: '文件不存在', 'size-limit': '超过读取额度', 'changed-during-read': '读取期间有变化', 'unreadable-or-disallowed': '无法读取或路径不允许' })[row.state] || row.state}`)))),
      data && h('p', { className: 'muted' }, `共享累计用量：输入 ${data.accounting?.inputTokens ?? '未知'} / 输出 ${data.accounting?.outputTokens ?? '未知'} token。${data.accounting?.usageMissing ? '包含保守预留量，不能视作实际账单。' : '以提供方账单为准。'}`),
      data && h('p', { className: 'muted' }, '导出包含任务标题、标识与相对路径；对外分享前请自行检查。'),
      data && h(RawDetails, { label: '精确回执、阻碍与审计字段', value: data }));
  }
  function Detail({ task, api = request, back, openTask }) {
    const [restoring, setRestoring] = useState(false), [restoreMessage, setRestoreMessage] = useState('');
    const [reader] = useState(() => new ResultReader(task.sessionId, api)), [trace] = useState(() => new TraceReader(task.sessionId, api)), [, render] = useState(0), [tab, setTab] = useState(task.initialTab || '过程');
    useEffect(() => {
      reader.changed = () => render(n => n + 1); void reader.load(); return () => reader.dispose();
    }, [reader]);
    useEffect(() => { trace.changed = () => render(n => n + 1); void trace.load(); return () => trace.dispose(); }, [trace]);
    const { result, error, loading } = reader.state, detail = result;
    const text = tab === '任务' ? result?.originalTask : result?.text || (result?.running ? '任务尚未返回可见结果。' : '没有可见答案；请检查终止原因。');
    return h('div', null,
      h('button', { className: 'ghost', onClick: back }, '← 返回协作中心'),
      h('header', null, h('div', { className: 'grow' }, h('h1', null, task.title), h('p', { className: 'muted subtitle' }, folderName(task.cwd || '未知工作区'))),
        h('span', { className: 'status', 'data-busy': !!result?.running }, result ? statusLabel(result.status) : '读取中'),
        h('button', { disabled: loading || trace.state.loading, onClick: () => { void reader.load(); void trace.load(); } }, loading ? '读取中…' : '刷新详情')),
      error && h('div', { role: 'alert', className: 'notice' }, error),
      result?.admission?.blocked && h('div', { role: 'alert', className: 'notice' },
        h('p', null, result.admission.message),
        h('p', null, `阻断会话：${result.admission.blockingTitle}。恢复父级归档也会解除其子会话的归档限制，但不会启动它们。`),
        h('button', { disabled: restoring, onClick: async () => {
          setRestoring(true); setRestoreMessage('');
          try { await api('deepseek_session_archive', { session_id: result.admission.blockingSessionId, action: 'restore' });
            setRestoreMessage('已恢复指定会话的归档；历史阻断记录保留，未启动模型。'); await reader.load();
          } catch (e) { setRestoreMessage(e.message); } finally { setRestoring(false); }
        } }, restoring ? '恢复中…' : result.admission.scope === 'self' ? '恢复本会话归档' : '恢复父级归档')),
      result?.admission?.checkFailed && h('div', { role: 'alert', className: 'notice' }, result.admission.message),
      result?.status === 'blocked' && result.admission?.blocked === false && h('p', { className: 'notice' }, '当前归档规则已不再阻断。上次 blocked 是历史轮次状态；是否可以继续还需通过权限、预算及回执检查。'),
      restoreMessage && h('div', { role: 'status', className: 'notice' }, restoreMessage),
      h('style', null, conversationStyle), h('p', { className: 'readonly-label' }, '只读查看 · 不发送消息，不续跑任务'),
      h('div', { className: 'detail' }, h('section', null,
        h('nav', { className: 'tabs', role: 'tablist', 'aria-label': '任务详情' }, ['过程', '结果', '任务', '轨迹', '策略', '任务树', '交付', '恢复预演', ...(task.role === 'lead' ? ['调度'] : [])].map((name) => h('button', { key: name, role: 'tab', 'aria-selected': tab === name, onClick: () => setTab(name) }, name))),
        ['过程', '轨迹'].includes(tab) ? h(Trace, { key: tab, reader: trace, sessionId: task.sessionId, api, openTask, outline: tab === '轨迹' })
          : tab === '任务树' ? h(TaskTree, { sessionId: task.sessionId, api, openTask })
          : tab === '策略' ? h(Policy, { result })
          : tab === '调度' ? h(Schedules, { sessionId: task.sessionId, api })
          : ['交付', '恢复预演'].includes(tab) ? h(EvidencePanel, { key: tab, sessionId: task.sessionId, api, recovery: tab === '恢复预演' })
            : h('div', { className: 'answer', role: 'tabpanel', 'aria-label': tab }, result ? tab === '结果' ? h(NativeText, { text }) : h('pre', null, text) : '正在按需读取…'),
        result?.sourceTruncated && h('div', { className: 'notice' }, '源结果达到保留上限；这里不是完整 transcript。'),
        tab === '结果' && h(ScrollTail, { more: result?.nextOffset != null, loading, error, load: () => reader.load(true), retry: () => reader.load(), label: '结果' })),
        h(Metrics, { result, detail })));
  }
  function ReportFeed({ channel, api, refresh }) {
    const [reader] = useState(() => new ReportReader(channel, api)), [, render] = useState(0);
    useEffect(() => { reader.changed = () => render(n => n + 1); return () => reader.dispose(); }, [reader]);
    useEffect(() => { void reader.load(); }, [reader, refresh]);
    const { data, loading, error } = reader.state;
    return h('div', { className: 'report-list' },
      error && h('div', { className: 'notice', role: 'alert' }, error),
      data?.gap && h('div', { className: 'notice' }, `历史报告 ${data.gap.from}–${data.gap.through} 已超出保留窗口，请检查最新任务状态。`),
      data?.clipped && h('p', { className: 'muted' }, '仅保留最近 256 条汇报，较早内容已从此视图释放。'),
      data?.events.map(event => h('section', { className: 'report', key: event.seq },
        h('div', { className: 'report-heading' }, h('span', null, `#${event.seq} · ${({ 'tasks.progress': '任务进展', 'tasks.settled': '任务已结算', 'tasks.needs_attention': '任务需要核验', 'watch.started': '汇报已启用', 'watch.expired': '汇报已到期', 'watch.stopped': '汇报已停止' })[event.type] || event.type}`), h('time', { className: 'muted' }, new Date(event.time).toLocaleString())),
        h('div', { className: 'report-body' },
          event.snapshot.message && h('div', { className: 'notice' }, event.snapshot.message),
          event.snapshot.tasks?.slice(0, 3).map((task, index) => h('div', { className: 'row', key: task.sessionId }, h('span', { className: 'status' }, statusLabel(task.state || task.status)),
            h('div', { className: 'grow' }, h('div', { className: 'report-id' }, task.title || `任务 ${index + 1} · 精确标识见审计详情`), h('pre', { className: 'report-preview' }, (task.visiblePreview || '暂无可见结果，请检查任务详情。').slice(0, 600))))),
          event.snapshot.tasks?.length > 3 && h('p', { className: 'muted' }, `另有 ${event.snapshot.tasks.length - 3} 个任务，展开原始报告查看。`),
          event.snapshot.budgets?.map(budget => h('p', { className: 'muted', key: budget.rootId }, `共享账本 · 请求 ${budget.usage.requests ?? '未知'} · 输入 ${budget.usage.inputTokens ?? '未知'} · 输出 ${budget.usage.outputTokens ?? '未知'} · 在途 ${budget.inFlightRequests}`)),
          event.snapshot.tasksTruncated && h('p', { className: 'notice' }, '任务摘要已截断，请在协作中心查看完整任务列表。'),
          h(RawDetails, { label: '原始报告与精确 ID', value: event.snapshot })))),
      h(ScrollTail, { more: !!data && data.nextCursor < data.latestSeq, loading, error, load: () => reader.load(), label: '已保存汇报' }));
  }
  function Reports({ back, api = request }) {
    const [channels, setChannels] = useState([]), [selected, setSelected] = useState('');
    const [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false);
    useEffect(() => {
      const controller = new AbortController(); setLoading(true); setError('');
      api('deepseek_notifications', {}, controller.signal)
        .then(list => { if (!controller.signal.aborted) { setChannels(list.channels); if (list.errors?.length) setError(json(list.errors)); } })
        .catch(e => { if (!controller.signal.aborted) setError(`查询失败，保留上次记录：${e.message}`); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
      return () => controller.abort();
    }, [refresh]);
    const active = channels.find(c => c.channel === selected);
    return h('div', null, h('button', { className: 'ghost', onClick: back }, '← 返回协作中心'), h('header', null, h('h1', { className: 'grow' }, '后台汇报'),
      h('button', { disabled: loading, onClick: () => setRefresh(n => n + 1) }, '刷新汇报')),
      h('p', { className: 'muted' }, '报告由 DSH 后台保存，不调用模型。本页不确认 Codex 的收件游标；关闭窗口后仍需保持后台运行。'),
      error && h('div', { className: 'notice', role: 'alert' }, error),
      h('div', { className: 'toolbar' }, h('select', { className: 'grow', 'aria-label': '汇报频道', value: selected, onChange: e => setSelected(e.target.value) },
        h('option', { value: '' }, '选择汇报频道'), channels.map(c => h('option', { key: c.channel, value: c.channel }, `${c.channel} · ${c.watch?.state || c.latestType}`))),
        active?.watch?.state === 'active' && h('button', { disabled: loading, onClick: async () => {
          setLoading(true);
          try { await api('deepseek_watch', { watch_id: selected, action: 'stop' }); setRefresh(n => n + 1); }
          catch (e) { setError(e.message); } finally { setLoading(false); }
        } }, '停止汇报（不停止任务）')),
      !channels.length && !loading && h('p', { className: 'empty' }, '尚无汇报。可在任务右键菜单中启用。'),
      selected ? h(ReportFeed, { key: selected, channel: selected, api, refresh }) : channels.length > 0 && h('p', { className: 'empty' }, '选择频道，沿时间线查看进度与结果。'));
  }
  function Workbench() {
    const [observer] = useState(() => new Observer()), [, render] = useState(0);
    const [expanded, setExpanded] = useState({}), [selected, setSelected] = useState(null), [checked, setChecked] = useState({});
    const [archived, setArchived] = useState(false), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
    const [menu, setMenu] = useState(null), [notice, setNotice] = useState(''), [action, setAction] = useState(false);
    const [reports, setReports] = useState(false);
    const root = useRef(null), listTop = useRef(0);
    const openTask = task => { listTop.current = root.current.scrollTop; setMenu(null); setSelected(task); };
    const openMenu = (e, task) => {
      e.preventDefault(); e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      setMenu({ task, x: Math.max(8, Math.min(e.clientX || rect.left, innerWidth - 280)), y: Math.max(8, Math.min(e.clientY || rect.bottom, innerHeight - 260)) });
    };
    useEffect(() => { if (root.current) root.current.scrollTop = selected || reports ? 0 : listTop.current; }, [selected, reports]);
    useEffect(() => { observer.changed = () => render((n) => n + 1); return () => observer.dispose(); }, []);
    useEffect(() => {
      if (selected || reports) { observer.pause(); return; }
      return autoRefresh(observer, { archived });
    }, [archived, selected, reports]);
    useEffect(() => {
      const close = () => setMenu(null), key = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('click', close); document.addEventListener('keydown', key);
      return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', key); };
    }, []);
    async function perform(operation, tasks, archiveAction = 'archive') {
      if (action) return;
      if (operation === 'deepseek_task_cancel' && !window.confirm(`取消 ${tasks.length} 个任务及其后代？关闭页面本身不会取消任务。`)) return;
      setAction(true); setMenu(null); const failed = [];
      for (const task of tasks) try {
        await request(operation, { session_id: task.sessionId, ...(operation === 'deepseek_task_cancel' ? { scope: 'tree' } : { action: archiveAction }) });
        if (operation === 'deepseek_session_archive') observer.state.tasks = observer.state.tasks.filter(row => row.sessionId !== task.sessionId);
      }
        catch (e) { failed.push(`${task.title}: ${e.message}`); }
      setNotice(failed.length ? failed.join('\n') : operation === 'deepseek_task_cancel' ? '已请求取消；须等待任务静止后才能归档。' : archiveAction === 'restore' ? '已恢复归档；没有发送消息或重跑任务。' : '已归档，记录未被删除。原生子会话在父级归档期间也无法继续。');
      setAction(false); setChecked({}); observer.load({ archived });
    }
    if (reports) return h('div', { className: 'dsh-collab', ref: root }, h('style', null, css), h(Reports, { back: () => setReports(false) }));
    if (selected) return h('div', { className: 'dsh-collab', ref: root }, h('style', null, css), h(Detail, { key: selected.sessionId, task: selected, back: () => setSelected(null), openTask }));
    const state = observer.state, groups = new Map();
    for (const task of state.tasks) {
      if (filter === 'running' && !busy(task) || filter === 'lead' && task.role !== 'lead'
          || !`${task.title} ${task.cwd} ${task.sessionId}`.toLowerCase().includes(query.toLowerCase())) continue;
      const list = groups.get(task.cwd || '未知工作区') || []; list.push(task); groups.set(task.cwd || '未知工作区', list);
    }
    const picked = state.tasks.filter((task) => checked[task.sessionId]);
    return h('div', { className: 'dsh-collab', ref: root }, h('style', null, css),
      h('header', null, h('div', { className: 'grow' }, h('h1', null, '协作中心'), h('p', { className: 'muted subtitle' }, `${state.total} 个任务 · 按工作区管理`)),
        h('button', { onClick: () => { listTop.current = root.current.scrollTop; setReports(true); } }, '后台汇报'),
        h('button', { disabled: state.loading, onClick: () => observer.load({ archived }) }, state.loading ? '读取中…' : '刷新')),
      h('div', { className: 'toolbar' }, h('input', { type: 'search', value: query, placeholder: '搜索已载入任务、工作区或 ID', 'aria-label': '搜索任务', onChange: (e) => setQuery(e.target.value) }),
        h('select', { value: filter, 'aria-label': '状态筛选', onChange: (e) => setFilter(e.target.value) }, h('option', { value: 'all' }, '全部任务'), h('option', { value: 'running' }, '进行中 / 待核对'), h('option', { value: 'lead' }, 'Lead')),
        h('label', null, h('input', { type: 'checkbox', checked: archived, onChange: (e) => { setChecked({}); setArchived(e.target.checked); } }), ' 包含归档')),
      picked.length > 0 && h('div', { className: 'selection' }, h('span', { className: 'grow' }, `已选择 ${picked.length} 个任务`),
        h('button', { className: 'ghost', onClick: () => setChecked({}) }, '清除选择'),
        h('button', { disabled: action || picked.some(task => busy(task) || task.archived), onClick: () => perform('deepseek_session_archive', picked) }, '归档所选')),
      (state.error || notice) && h('div', { className: 'notice', role: 'status' }, h('pre', null, state.error || notice)),
      h('p', { className: 'muted' }, '点击工作区展开任务 · 右键或 ··· 管理任务'),
      [...groups].map(([cwd, tasks]) => h('section', { className: 'workspace', key: cwd },
        h('button', { className: 'workspace-head', 'aria-expanded': !!expanded[cwd], onClick: () => setExpanded((old) => ({ ...old, [cwd]: !old[cwd] })) },
          h('span', { className: 'chevron', 'aria-hidden': true }, expanded[cwd] ? '▾' : '▸'),
          h('span', { className: 'grow' }, h('span', { className: 'workspace-name' }, folderName(cwd)), h('span', { className: 'workspace-path', title: cwd }, cwd)), h('span', { className: 'count' }, tasks.length)),
        expanded[cwd] && treeRows(tasks).map(({ node: task, depth }) => h('div', { className: 'row', key: task.sessionId, style: { paddingLeft: `${12 + Math.min(depth, 8) * 20}px` }, onContextMenu: e => openMenu(e, task),
          onKeyDown: e => { if (e.key === 'F10' && e.shiftKey) openMenu(e, task); } },
          h('input', { type: 'checkbox', 'aria-label': `选择 ${task.title}`, checked: !!checked[task.sessionId], onChange: (e) => setChecked({ ...checked, [task.sessionId]: e.target.checked }) }),
          h('button', { className: 'task', onClick: () => openTask(task) }, h('span', null, task.title), h('span', { className: 'muted', title: task.sessionId }, `${task.role === 'lead' ? 'Lead' : 'Agent'}${task.createdAt ? ` · ${new Date(task.createdAt).toLocaleDateString()}` : ''}`)),
          h('span', { className: 'status', 'data-busy': !!busy(task) }, task.archived ? '已归档' : task.running ? '运行中' : task.admission?.blocked ? '父级已归档' : statusLabel(task.submission?.outcome?.kind || task.submission?.outcome || task.submission?.state)),
          h('button', { className: 'more', 'aria-label': `${task.title} 的操作`, 'aria-haspopup': 'menu', onClick: e => openMenu(e, task) }, '···'))))),
      !groups.size && h('div', { className: 'empty' }, state.error ? '暂时无法获取记录。' : '当前筛选下没有任务。'),
      h(ScrollTail, { more: state.nextOffset != null, loading: state.loading, error: state.error, load: () => observer.load({ append: true, archived }), retry: () => observer.load({ archived }), label: '任务' }),
      menu && h('div', { className: 'menu', role: 'menu', style: { left: menu.x, top: menu.y }, onClick: (e) => e.stopPropagation() },
        h('button', { role: 'menuitem', onClick: () => openTask(menu.task) }, '查看详情'),
        h('button', { role: 'menuitem', onClick: () => { navigator.clipboard.writeText(menu.task.sessionId).catch((e) => setNotice(e.message)); setMenu(null); } }, '复制任务 ID'),
        h('button', { role: 'menuitem', disabled: action, onClick: async () => {
          const id = menu.task.sessionId; setMenu(null); setAction(true);
          try { const receipt = await request('deepseek_watch', { action: 'start', watch_id: `watch-${crypto.randomUUID()}`, session_ids: [id], interval_seconds: 300, duration_seconds: 86400 });
            setNotice(`后台汇报已保存：${receipt.channel}。每 5 分钟检查，最长 24 小时；结束时汇报。Codex 唤醒需另外启用宿主自动化。`); }
          catch (e) { setNotice(e.message); } finally { setAction(false); }
        } }, '启用后台汇报（5 分钟）'),
        h('button', { role: 'menuitem', disabled: action, onClick: () => perform('deepseek_task_cancel', [menu.task]) }, '取消任务及后代'),
        h('button', { role: 'menuitem', onClick: () => openTask({ ...menu.task, initialTab: '恢复预演' }) }, '查看恢复预演'),
        menu.task.archived
          ? h('button', { role: 'menuitem', disabled: action, onClick: () => perform('deepseek_session_archive', [menu.task], 'restore') }, '恢复归档')
          : h('button', { role: 'menuitem', disabled: action || busy(menu.task), onClick: () => perform('deepseek_session_archive', [menu.task]) }, '归档')));
  }
  function apply(ctx) {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Workbench));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 10, label: '协作中心' },
      () => h('span', { 'aria-hidden': true }, '◇')));
  }
  return { apply, inject: ['slots', 'layout'], Observer, autoRefresh, ResultReader, TraceReader, ReportReader, connectScrollTail, treeRows, conversationGroups, EvidencePanel, Detail };
} });
