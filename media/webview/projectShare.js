(function () {
  'use strict';
  const root = document.getElementById('project-share');
  const token = location.pathname.split('/').pop();
  const endpoint = '/api/projects/share/' + encodeURIComponent(token);
  let board, loading = false, refreshQueued = false, selected, live = false, showArchive = false, events, shareEpoch = 0;
  const allowed = feature => Boolean(navigator.onLine && live && board?.expiresAt > Date.now() && (board?.permissions.includes(feature) || (feature === 'activities' && board?.permissions.includes('messages'))));
  function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
  const status = node('p', '', 'task-board-status'); status.setAttribute('role', 'status');
  const heading = node('h1', 'Shared project');
  const columns = node('div', undefined, 'task-board-columns');
  const toolbar = node('div', undefined, 'task-board-subtoolbar');
  const search = node('input'); search.type = 'search'; search.placeholder = 'Search tasks…'; search.setAttribute('aria-label', 'Search tasks');
  const archive = node('button', 'Archive'); archive.type = 'button'; archive.setAttribute('aria-pressed', 'false');
  search.oninput = () => renderBoard(); archive.onclick = () => { showArchive = !showArchive; archive.setAttribute('aria-pressed', String(showArchive)); archive.textContent = showArchive ? 'Back to board' : 'Archive'; renderBoard(); };
  const refreshButton = node('button', 'Refresh'); refreshButton.type = 'button'; refreshButton.onclick = () => { stopEvents(); void refresh(); };
  toolbar.append(search, archive, refreshButton);
  const form = node('form', undefined, 'public-project-form'); form.hidden = true;
  const title = node('input'); title.placeholder = 'Task or idea title'; title.maxLength = 240; title.required = true; title.setAttribute('aria-label', 'Request title');
  const prompt = node('textarea'); prompt.placeholder = 'Describe what you need…'; prompt.maxLength = 32000; prompt.setAttribute('aria-label', 'Request details');
  const author = node('input'); author.placeholder = 'Your name (optional)'; author.maxLength = 60; author.setAttribute('aria-label', 'Your name');
  const submit = node('button', 'Submit idea'); submit.type = 'submit';
  const submissionStatus = node('span'); submissionStatus.setAttribute('role', 'status');
  form.append(node('h2', 'Suggest an idea'), title, prompt, author, submit, submissionStatus);
  root.replaceChildren(heading, status, toolbar, columns, form);
  const draftKey = 'codexManager.publicDraft:' + token.slice(0, 12);
  let draftId = crypto.randomUUID(), draftAttempt, submitting = false;
  try { const draft = JSON.parse(localStorage.getItem(draftKey) || '{}'); title.value = draft.title || ''; prompt.value = draft.prompt || ''; author.value = draft.author || ''; draftId = draft.id || draftId; draftAttempt = draft.attempt; } catch { /* storage optional */ }
  function saveDraft() { try { localStorage.setItem(draftKey, JSON.stringify({ id: draftId, attempt: draftAttempt, title: title.value, prompt: prompt.value, author: author.value })); return true; } catch { submissionStatus.textContent = 'Draft is kept in this tab only. Copy it before closing.'; return false; } }
  form.addEventListener('input', saveDraft);
  function stopEvents() { events?.close(); events = undefined; }
  function clearSharedView() {
    shareEpoch++; refreshQueued = false; stopEvents(); live = false; board = undefined; columns.replaceChildren(); form.hidden = true; selected?.dispatchEvent(new Event('close'));
  }
  function connectEvents() {
    if (events || !board || !navigator.onLine || document.hidden || !window.EventSource) return;
    try { events = new EventSource(endpoint + '/events'); } catch { return; }
    events.addEventListener('ready', () => { void refresh(); });
    events.addEventListener('change', () => { void refresh(); });
    events.addEventListener('revoked', () => { clearSharedView(); status.textContent = 'This project link expired or was revoked.'; });
    events.addEventListener('unavailable', () => { live = false; submit.disabled = true; selected?.dispatchEvent(new Event('refresh')); status.textContent = 'Live updates are unavailable. Your draft was kept; reconnect or refresh.'; });
    events.onerror = () => { if (navigator.onLine && !document.hidden) void refresh(); };
  }
  async function request(body, task, view, before, file) {
    const epoch = shareEpoch;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint + (task ? '?' + new URLSearchParams({ task, view: view || 'activities', ...(before ? { before } : {}), ...(file ? { file } : {}) }) : ''), { method: body ? 'POST' : 'GET', signal: controller.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Codex-Dashboard': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); if (!response.ok) { if (response.status === 404) clearSharedView(); throw new Error(result.error || 'Project request failed.'); }
      if (epoch !== shareEpoch) throw new Error('This project link expired or was revoked.');
      return result;
    } finally { clearTimeout(timer); }
  }
  function openTask(task) {
    selected?.dispatchEvent(new Event('close'));
    const dialog = node('aside', undefined, 'task-detail-panel public-task-dialog'); selected = dialog; dialog.dataset.task = task.id;
    dialog.setAttribute('aria-label', task.title); dialog.tabIndex = -1;
    const close = node('button', '×', 'settings-close'); close.type = 'button'; close.setAttribute('aria-label', 'Close task details'); close.onclick = () => dialog.dispatchEvent(new Event('close'));
    dialog.onkeydown = event => { if (event.key === 'Escape') { close.click(); event.stopPropagation(); } };
    const activity = node('div', 'Loading activity…', 'task-detail-scroll');
    const comments = node('div', undefined, 'task-comments'); comments.hidden = !allowed('comments'); comments.append(node('h3', 'Comments'));
    const feedback = node('p'); feedback.setAttribute('role', 'status');
    const commentList = node('div', undefined, 'public-comment-list'); commentList.dataset.task = task.id;
    for (const item of board.comments.filter(comment => comment.taskId === task.id)) { const entry = node('article', undefined, 'task-activity'); entry.append(node('small', item.author), node('p', item.text)); commentList.append(entry); }
    comments.append(commentList);
    const input = node('textarea'); input.placeholder = 'Add a comment…'; input.maxLength = 8000; input.setAttribute('aria-label', 'Comment');
    const commentButton = node('button', 'Add comment'); commentButton.type = 'button';
    let commentId = crypto.randomUUID(), savedText = '', commenting = false;
    commentButton.onclick = async () => {
      if (commenting || !input.value.trim() || !allowed('comments')) return;
      if (savedText && savedText !== input.value) commentId = crypto.randomUUID(); savedText = input.value;
      commenting = true; input.readOnly = true; commentButton.disabled = true; feedback.textContent = 'Posting comment…';
      try { await request({ kind: 'comment', id: commentId, taskId: task.id, text: input.value, author: author.value }); commentList.append(node('p', input.value)); input.value = ''; commentId = crypto.randomUUID(); savedText = ''; feedback.textContent = 'Comment added.'; void refresh(); }
      catch (error) { feedback.textContent = 'Comment not confirmed: ' + error.message + ' Your text was kept. Retry sends the same request safely.'; }
      finally { commenting = false; input.readOnly = false; commentButton.disabled = !allowed('comments'); }
    };
    comments.append(input, commentButton, feedback);
    const head = node('header', undefined, 'settings-modal-head'); head.append(node('strong', task.title, 'settings-modal-title'), close);
    const body = node('div', undefined, 'task-detail-panel-body'); body.append(node('p', task.prompt || ''), activity, comments);
    dialog.append(head, body); root.append(dialog); dialog.focus();
    const tabs = node('div', undefined, 'task-detail-tabs'), content = node('div');
    activity.replaceChildren(tabs, content);
    let view, before, generation = 0, pending = false, reloadPending = false, renderedSignature;
    async function load(nextView, cursor) {
      view = nextView; before = cursor;
      const requestId = ++generation;
      if (!allowed(view)) { content.replaceChildren(node('p', 'This feature is not shared.')); return; }
      pending = true;
      try {
        const data = await request(undefined, task.id, view, cursor);
        if (requestId !== generation || !dialog.isConnected) return;
        const signature = JSON.stringify([view, cursor, data]);
        if (signature === renderedSignature) return;
        renderedSignature = signature;
        content.replaceChildren();
        for (const warning of data.warnings || []) content.append(node('p', warning));
        if (cursor) { const latest = node('button', 'Latest activity'); latest.type = 'button'; latest.onclick = () => { void load(view); }; content.append(latest); }
        if (data.olderThan) { const older = node('button', 'Older history'); older.type = 'button'; older.onclick = () => { void load(view, data.olderThan); }; content.append(older); }
        if (window.renderCodexSharedMessages && data.messages?.length) { const messages = node('div'); content.append(messages); window.renderCodexSharedMessages(messages, data.messages); }
        else for (const item of data.messages || []) {
          const entry = node('article', undefined, 'task-activity'); entry.append(node('strong', item.role || item.kind), node('pre', [item.title,item.text,item.command,item.output,item.result,item.arguments].filter(Boolean).join('\n')));
          for (const change of item.changes || []) entry.append(node('strong', change.path), node('pre', change.diff || change.kind)); content.append(entry);
        }
        for (const file of data.files || []) {
          const row = node('button', file.path, 'task-file-row'); row.type = 'button'; row.disabled = file.type !== 'file';
          row.onclick = async () => { try { const result = await request(undefined, task.id, 'files', cursor, file.path); if (dialog.isConnected && view === 'files') { const preview = node('article', undefined, 'task-activity'); preview.append(node('strong', result.file.path), node('pre', result.file.content)); content.append(preview); } } catch (error) { feedback.textContent = error.message; } };
          content.append(row);
        }
        if (view === 'changes') content.prepend(node('p', 'Current project changes: ' + (data.changes || 0) + ' · +' + (data.additions || 0) + ' / −' + (data.deletions || 0)));
        if (!content.childNodes.length) content.append(node('p', 'No activity on this history page.'));
      } catch (error) { if (requestId === generation) feedback.textContent = 'View could not refresh: ' + error.message; }
      finally { if (requestId === generation) { pending = false; if (reloadPending) { reloadPending = false; revalidate(); } } }
    }
    const features = ['activities','files','changes'].filter(allowed);
    tabs.setAttribute('role', 'tablist');
    for (const feature of features) { const tab = node('button', feature[0].toUpperCase() + feature.slice(1)); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.onclick = () => { for (const item of tabs.children) item.setAttribute('aria-selected', String(item === tab)); void load(feature); }; tab.setAttribute('aria-selected', String(feature === features[0])); tabs.append(tab); }
    const subtasks = board.tasks.filter(child => child.parentTaskId === task.id);
    if (subtasks.length) { const children = node('div', undefined, 'task-subtasks'); children.append(node('h3', 'Subtasks')); for (const child of subtasks) { const link = node('button', child.title); link.type = 'button'; link.onclick = () => openTask(child); children.append(link); } body.insertBefore(children, activity); }
    if (features[0]) void load(features[0]);
    const revalidate = () => { if (dialog.isConnected && !document.hidden && view === 'activities' && !before && live) { if (pending) reloadPending = true; else void load(view); } commentButton.disabled = commenting || !allowed('comments'); };
    window.addEventListener('focus', revalidate); document.addEventListener('visibilitychange', revalidate); window.addEventListener('online', revalidate); window.addEventListener('offline', revalidate);
    dialog.addEventListener('refresh', revalidate);
    dialog.addEventListener('close', () => { window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', revalidate); window.removeEventListener('online', revalidate); window.removeEventListener('offline', revalidate); dialog.remove(); if (selected === dialog) selected = undefined; }, { once: true });
  }

  function renderBoard() {
    if (!board) return;
    columns.replaceChildren();
    columns.style.gridTemplateColumns = showArchive ? 'minmax(0,1fr)' : '';
    const ids = new Set(board.tasks.map(task => task.id));
    const query = search.value.trim().toLowerCase();
    for (const stage of showArchive ? ['archive'] : ['idea','planned','running','completed']) {
      const column = node('section', undefined, 'task-board-column is-' + stage);
      const rows = board.tasks.filter(task => (showArchive ? task.sessionArchived : task.stage === stage && (!task.parentTaskId || !ids.has(task.parentTaskId))) && (!query || (task.title + '\n' + task.prompt).toLowerCase().includes(query)));
      column.append(node('h2', stage[0].toUpperCase() + stage.slice(1) + ' · ' + rows.length, 'task-board-column-heading'));
      const list = node('div', undefined, 'task-board-card-list');
      let visible = 50;
      const more = node('button', 'Show more'); more.type = 'button';
      const append = () => { more.remove(); for (const task of rows.slice(visible - 50, visible)) { const card = node('button', undefined, 'task-board-card'); card.type = 'button'; card.append(node('strong', task.title), node('p', task.prompt || '')); card.onclick = () => openTask(task); list.append(card); } if (rows.length > visible) list.append(more); };
      more.onclick = () => { visible += 50; append(); }; append(); column.append(list); columns.append(column);
    }
  }
  async function refresh() {
    if (loading) { refreshQueued = true; return; } loading = true;
    try {
      const next = await request(); const changed = !board || JSON.stringify(next.tasks) !== JSON.stringify(board.tasks), commentsChanged = !board || JSON.stringify(next.comments) !== JSON.stringify(board.comments); board = next; live = navigator.onLine; heading.textContent = board.title; form.hidden = !board.permissions.includes('submissions'); submit.disabled = submitting || !allowed('submissions'); if (changed) renderBoard();
      if (selected && !board.tasks.some(task => task.id === selected.dataset.task)) selected.dispatchEvent(new Event('close'));
      const comments = selected?.querySelector('.public-comment-list');
      if (comments && commentsChanged) { comments.replaceChildren(); for (const item of board.comments.filter(comment => comment.taskId === comments.dataset.task)) { const entry = node('article', undefined, 'task-activity'); entry.append(node('small', item.author), node('p', item.text)); comments.append(entry); } }
      status.textContent = (live ? 'Shared project · expires ' : 'Offline. Saved view · expires ') + new Date(board.expiresAt).toLocaleString();
    } catch (error) { live = false; submit.disabled = true; status.textContent = (board ? 'Saved view retained. ' : '') + error.message + ' Reconnect before submitting.'; }
    finally {
      loading = false; selected?.dispatchEvent(new Event('refresh')); connectEvents();
      if (refreshQueued) { refreshQueued = false; if (board && navigator.onLine && !document.hidden) void refresh(); }
    }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (submitting || !allowed('submissions')) return;
    const attempt = JSON.stringify([title.value, prompt.value]);
    if (draftAttempt && draftAttempt !== attempt) draftId = crypto.randomUUID();
    draftAttempt = attempt;
    const localOnly = saveDraft() ? '' : ' Draft is kept in this tab only. Copy it before closing.';
    submitting = true; title.readOnly = true; prompt.readOnly = true; submit.disabled = true; submissionStatus.textContent = 'Submitting idea…' + localOnly;
    try { await request({ kind: 'task', id: draftId, title: title.value, prompt: prompt.value }); title.value = ''; prompt.value = ''; draftId = crypto.randomUUID(); draftAttempt = undefined; try { localStorage.removeItem(draftKey); } catch { /* optional */ } submissionStatus.textContent = 'Idea submitted for the project owner to review.'; void refresh(); }
    catch (error) { submissionStatus.textContent = 'Submission not confirmed: ' + error.message + ' Your draft was kept. Retry safely using the same form.' + localOnly; }
    finally { submitting = false; title.readOnly = false; prompt.readOnly = false; submit.disabled = !allowed('submissions'); }
  };
  window.addEventListener('offline', () => { stopEvents(); live = false; submit.disabled = true; status.textContent = 'Offline. Your draft is kept; requests are not sent automatically.'; });
  window.addEventListener('pagehide', stopEvents);
  window.addEventListener('pageshow', () => { if (navigator.onLine) void refresh(); });
  const revalidate = () => { if (document.hidden) stopEvents(); else if (navigator.onLine) { if (events?.readyState === window.EventSource?.CLOSED) stopEvents(); void refresh(); } };
  window.addEventListener('focus', revalidate); document.addEventListener('visibilitychange', revalidate); window.addEventListener('online', revalidate);
  void refresh();
})();
