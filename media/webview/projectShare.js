(() => {
  'use strict';
  const root = document.getElementById('project-share'), token = location.pathname.split('/').pop();
  if (!root || !token) return;
  const endpoint = '/api/projects/share/' + encodeURIComponent(token), draftKey = 'codexManager.publicDraft:' + token.slice(0,12);
  const host = document.createElement('div'), status = document.createElement('p');
  host.className = 'public-board-host'; status.className = 'task-board-status'; status.setAttribute('role','status'); root.replaceChildren(host,status);
  let data, live = false, stopped = false, events, epoch = 0, loading, queued = false;
  const allowed = feature => data?.permissions.includes(feature) || feature === 'activities' && data?.permissions.includes('messages');
  const board = () => ({ projectPath:'shared-project',tasks:(data?.tasks || []).map(task => ({ revision:1,createdAt:0,updatedAt:0,...task })),comments:data?.comments || [],sessions:[],updatedAt:Date.now() });
  const stopEvents = () => { events?.close(); events = undefined; };
  function clear() { stopped = true; epoch++; queued = false; stopEvents(); live = false; data = undefined; window.clearCodexSharedMessages?.(host); host.replaceChildren(); status.textContent = 'This project link expired or was revoked.'; }
  async function request(body, query) {
    const current = epoch, controller = new AbortController(), timer = setTimeout(() => controller.abort(),15000);
    try {
      const response = await fetch(endpoint + (query ? '?' + new URLSearchParams(query) : ''), { method:body ? 'POST' : 'GET',signal:controller.signal,cache:'no-store',headers:{'Content-Type':'application/json','X-Codex-Dashboard':'1'},...(body ? {body:JSON.stringify(body)} : {}) });
      if (response.status === 404) { clear(); throw new Error('This project link expired or was revoked.'); }
      const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Project request failed.');
      if (stopped || current !== epoch) throw new Error('This project link expired or was revoked.');
      return value;
    } finally { clearTimeout(timer); }
  }
  async function action(name, payload) {
    if (stopped || !live || !navigator.onLine || !data || data.expiresAt <= Date.now()) throw new Error('Reconnect before submitting. This operation was not sent or queued.');
    if (name === 'getProjectBoard') { await refresh(); return {projectBoard:board()}; }
    if (name === 'getProjectTaskDetails' || name === 'readWorkspaceFile') {
      const view = name === 'readWorkspaceFile' ? 'files' : payload.taskView || 'activities';
      if (!allowed(view)) throw new Error('This feature is not shared.');
      const result = await request(undefined,{task:payload.taskId,view,...(payload.taskBefore ? {before:payload.taskBefore} : {}),...(name === 'readWorkspaceFile' ? {file:payload.filePath} : {})});
      return name === 'readWorkspaceFile' ? {workspaceFile:result.file} : {projectTaskDetails:{taskId:payload.taskId,messages:[],files:[],history:[],warnings:[],...result,...(result.changes !== undefined ? {environment:{changes:result.changes,additions:result.additions,deletions:result.deletions,branchDiff:result.branchDiff}} : {})}};
    }
    if (name === 'saveProjectTask' && allowed('submissions') && payload.task?.expectedRevision === 0 && !payload.task?.parentTaskId && payload.task?.stage === 'idea') {
      await request({kind:'task',id:payload.task.id,title:payload.task.title,prompt:payload.task.prompt,uploads:payload.task.uploads}); await refresh(); return {projectBoard:board()};
    }
    if (name === 'addProjectComment' && allowed('comments') && payload.comment) {
      await request({kind:'comment',...payload.comment}); await refresh(); return {projectBoard:board()};
    }
    throw new Error('This operation is not enabled for this shared link.');
  }
  function render() {
    if (!data || stopped) return;
    window.renderCodexSharedBoard?.(host,{sessions:[],projects:[{id:'shared-project',path:'shared-project',label:data.title}],connected:live,systemName:data.title,sendAction:()=>undefined,onOpenSession:()=>{},shared:{draftKey,board:board(),permissions:data.permissions,request:action}});
  }
  function connect() {
    if (events || stopped || !data || !navigator.onLine || document.hidden || !window.EventSource) return;
    try { const source = new EventSource(endpoint + '/events'); events = source;
      const changed = () => { if (events === source) void refresh(); };
      source.addEventListener('ready',changed); source.addEventListener('change',changed);
      source.addEventListener('revoked',()=>{if(events===source)clear();});
      source.addEventListener('unavailable',()=>{if(events===source){stopEvents();live=false;render();status.textContent='Live updates are unavailable. Your draft was kept; reconnect or refresh.';}});
      source.onerror=()=>{if(events===source){live=false;render();status.textContent='Reconnecting. Saved view retained.';}};
    } catch { status.textContent='Live updates are unavailable. Refresh to retry.'; }
  }
  async function refresh() {
    if (stopped || !navigator.onLine || document.hidden) return;
    if (loading) { queued=true;return loading; }
    loading=(async()=>{try{data=await request();live=true;status.textContent='';render();}catch(error){if(!stopped){live=false;render();status.textContent=(data?'Saved view retained. ':'')+error.message+' Reconnect before submitting.';}}})().finally(()=>{loading=undefined;connect();if(queued&&!stopped){queued=false;void refresh();}});
    return loading;
  }
  const revalidate=()=>{if(document.hidden||!navigator.onLine)stopEvents();else{if(events?.readyState===window.EventSource?.CLOSED)stopEvents();void refresh();}};
  window.addEventListener('offline',()=>{epoch++;queued=false;stopEvents();live=false;render();if(!stopped)status.textContent='Offline. Your draft is kept; requests are not sent automatically.';});
  window.addEventListener('pagehide',()=>{epoch++;queued=false;stopEvents();});
  window.addEventListener('pageshow',revalidate);window.addEventListener('focus',revalidate);window.addEventListener('online',revalidate);document.addEventListener('visibilitychange',revalidate);
  void refresh();
})();
