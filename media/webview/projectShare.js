(function () {
  'use strict';
  const root = document.getElementById('project-share');
  const token = location.pathname.split('/').pop();
  const endpoint = '/api/projects/share/' + encodeURIComponent(token);
  let board, loading = false, selected, live = false;
  const allowed = feature => Boolean(live && board?.permissions.includes(feature));
  function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
  const status = node('p', '', 'task-board-status'); status.setAttribute('role', 'status');
  const heading = node('h1', 'Shared project');
  const columns = node('div', undefined, 'task-board-columns');
  const form = node('form', undefined, 'public-project-form'); form.hidden = true;
  const title = node('input'); title.placeholder = 'Task or idea title'; title.maxLength = 240; title.required = true; title.setAttribute('aria-label', 'Request title');
  const prompt = node('textarea'); prompt.placeholder = 'Describe what you need…'; prompt.maxLength = 32000; prompt.setAttribute('aria-label', 'Request details');
  const author = node('input'); author.placeholder = 'Your name (optional)'; author.maxLength = 60; author.setAttribute('aria-label', 'Your name');
  const submit = node('button', 'Submit idea'); submit.type = 'submit';
  form.append(node('h2', 'Suggest an idea'), title, prompt, author, submit);
  root.replaceChildren(heading, status, columns, form);
  const draftKey = 'codexManager.publicDraft:' + token.slice(0, 12);
  let draftId = crypto.randomUUID();
  try { const draft = JSON.parse(localStorage.getItem(draftKey) || '{}'); title.value = draft.title || ''; prompt.value = draft.prompt || ''; author.value = draft.author || ''; draftId = draft.id || draftId; } catch { /* storage optional */ }
  form.addEventListener('input', () => { try { localStorage.setItem(draftKey, JSON.stringify({ id: draftId, title: title.value, prompt: prompt.value, author: author.value })); } catch { status.textContent = 'Draft is kept in this tab only. Copy it before closing.'; } });
  async function request(body, task, view, before, file) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint + (task ? '?' + new URLSearchParams({ task, view: view || 'messages', ...(before ? { before } : {}), ...(file ? { file } : {}) }) : ''), { method: body ? 'POST' : 'GET', signal: controller.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Codex-Dashboard': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); if (!response.ok) { if (response.status === 404) { live = false; columns.replaceChildren(); form.hidden = true; selected?.close(); selected?.remove(); selected = undefined; } throw new Error(result.error || 'Project request failed.'); } return result;
    } finally { clearTimeout(timer); }
  }
  function openTask(task) {
    selected?.remove();
    const dialog = node('dialog', undefined, 'public-task-dialog'); selected = dialog;
    const close = node('button', 'Close'); close.type = 'button'; close.onclick = () => { dialog.close(); dialog.remove(); selected = undefined; };
    const activity = node('div', 'Loading activity…', 'task-detail-scroll');
    const comments = node('div', undefined, 'task-comments'); comments.hidden = !allowed('comments'); comments.append(node('h3', 'Comments'));
    const feedback = node('p'); feedback.setAttribute('role', 'status');
    for (const item of board.comments.filter(comment => comment.taskId === task.id)) { const entry = node('article', undefined, 'task-activity'); entry.append(node('small', item.author), node('p', item.text)); comments.append(entry); }
    const input = node('textarea'); input.placeholder = 'Add a comment…'; input.maxLength = 8000; input.setAttribute('aria-label', 'Comment');
    const commentButton = node('button', 'Add comment'); commentButton.type = 'button';
    let commentId = crypto.randomUUID(), savedText = '';
    commentButton.onclick = async () => {
      if (!input.value.trim() || !allowed('comments')) return;
      if (savedText && savedText !== input.value) commentId = crypto.randomUUID(); savedText = input.value;
      commentButton.disabled = true;
      try { await request({ kind: 'comment', id: commentId, taskId: task.id, text: input.value, author: author.value }); comments.insertBefore(node('p', input.value), input); input.value = ''; commentId = crypto.randomUUID(); savedText = ''; status.textContent = 'Comment added.'; await refresh(); }
      catch (error) { feedback.textContent = 'Comment not confirmed: ' + error.message + ' Your text was kept. Retry sends the same request safely.'; }
      finally { commentButton.disabled = !allowed('comments'); }
    };
    comments.append(input, commentButton, feedback);
    dialog.append(close, node('h2', task.title), node('p', task.prompt || ''), activity, comments); root.append(dialog); dialog.showModal();
    const tabs = node('div', undefined, 'task-detail-tabs'), content = node('div');
    activity.replaceChildren(tabs, content);
    let view, before, generation = 0, pending = false;
    async function load(nextView, cursor) {
      view = nextView; before = cursor;
      const requestId = ++generation;
      if (!allowed(view)) { content.replaceChildren(node('p', 'This feature is not shared.')); return; }
      pending = true;
      try {
        const data = await request(undefined, task.id, view, cursor);
        if (requestId !== generation || !dialog.isConnected) return;
        content.replaceChildren();
        for (const warning of data.warnings || []) content.append(node('p', warning));
        if (cursor) { const latest = node('button', 'Latest activity'); latest.type = 'button'; latest.onclick = () => { void load(view); }; content.append(latest); }
        if (data.olderThan) { const older = node('button', 'Older history'); older.type = 'button'; older.onclick = () => { void load(view, data.olderThan); }; content.append(older); }
        for (const item of data.messages || []) {
          const entry = node('article', undefined, 'task-activity'); entry.append(node('strong', item.role || item.kind), node('pre', [item.title,item.text,item.command,item.output,item.result,item.arguments].filter(Boolean).join('\n')));
          for (const change of item.changes || []) entry.append(node('strong', change.path), node('pre', change.diff || change.kind)); content.append(entry);
        }
        for (const file of data.files || []) {
          const row = node('button', file.path, 'task-file-row'); row.type = 'button'; row.disabled = file.type !== 'file';
          row.onclick = async () => { try { const result = await request(undefined, task.id, 'files', undefined, file.path); if (dialog.isConnected && view === 'files') { const preview = node('article', undefined, 'task-activity'); preview.append(node('strong', result.file.path), node('pre', result.file.content)); content.append(preview); } } catch (error) { feedback.textContent = error.message; } };
          content.append(row);
        }
        if (view === 'changes') content.prepend(node('p', 'Current project changes: ' + (data.changes || 0) + ' · +' + (data.additions || 0) + ' / −' + (data.deletions || 0)));
        for (const commit of data.history || []) { const entry = node('article', undefined, 'task-activity'); entry.append(node('strong', commit.subject), node('small', commit.hash.slice(0,8) + ' · ' + commit.author + ' · ' + commit.date)); content.append(entry); }
        if (view === 'git' && data.isGitRepository === false) content.append(node('p', 'This project has no Git repository.'));
        if (!content.childNodes.length) content.append(node('p', 'No activity on this history page.'));
      } catch (error) { if (requestId === generation) feedback.textContent = 'View could not refresh: ' + error.message; }
      finally { if (requestId === generation) pending = false; }
    }
    const features = ['messages','activities','files','changes','git'].filter(allowed);
    for (const feature of features) { const tab = node('button', feature === 'git' ? 'Git history' : feature[0].toUpperCase() + feature.slice(1)); tab.type = 'button'; tab.onclick = () => { void load(feature); }; tabs.append(tab); }
    const subtasks = board.tasks.filter(child => child.parentTaskId === task.id);
    if (subtasks.length) { const children = node('div', undefined, 'task-subtasks'); children.append(node('h3', 'Subtasks')); for (const child of subtasks) { const link = node('button', child.title); link.type = 'button'; link.onclick = () => openTask(child); children.append(link); } dialog.insertBefore(children, activity); }
    if (features[0]) void load(features[0]);
    const timer = setInterval(() => { if (!dialog.isConnected) { clearInterval(timer); return; } if (!document.hidden && view && !before && !pending && live) void load(view); commentButton.disabled = !allowed('comments'); }, 5000);
    dialog.addEventListener('close', () => { clearInterval(timer); dialog.remove(); if (selected === dialog) selected = undefined; }, { once: true });
  }

  async function refresh() {
    if (loading) return; loading = true;
    try {
      const next = await request(); const changed = !board || JSON.stringify(next.tasks) !== JSON.stringify(board.tasks); board = next; live = true; heading.textContent = board.title; form.hidden = !allowed('submissions'); submit.disabled = !allowed('submissions'); if (changed) { columns.replaceChildren();
      for (const stage of ['idea','planned','running','completed']) {
        const column = node('section', undefined, 'task-board-column is-' + stage);
        const ids = new Set(board.tasks.map(task => task.id));
        const rows = board.tasks.filter(task => task.stage === stage && (!task.parentTaskId || !ids.has(task.parentTaskId)));
        column.append(node('h2', stage[0].toUpperCase() + stage.slice(1) + ' · ' + rows.length, 'task-board-column-heading'));
        for (const task of rows) { const card = node('button', undefined, 'task-board-card'); card.type = 'button'; card.append(node('strong', task.title), node('p', task.prompt || '')); card.onclick = () => openTask(task); column.append(card); }
        columns.append(column);
      }
      } status.textContent = 'Shared project · expires ' + new Date(board.expiresAt).toLocaleString();
    } catch (error) { live = false; submit.disabled = true; status.textContent = 'Saved view retained. ' + error.message + ' Reconnect before submitting.'; }
    finally { loading = false; }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (!allowed('submissions')) return; submit.disabled = true;
    try { await request({ kind: 'task', id: draftId, title: title.value, prompt: prompt.value }); title.value = ''; prompt.value = ''; draftId = crypto.randomUUID(); try { localStorage.removeItem(draftKey); } catch { /* optional */ } await refresh(); status.textContent = 'Idea submitted for the project owner to review.'; }
    catch (error) { status.textContent = 'Submission not confirmed: ' + error.message + ' Your draft was kept. Retry safely using the same form.'; }
    finally { submit.disabled = !allowed('submissions'); }
  };
  window.addEventListener('offline', () => { live = false; submit.disabled = true; status.textContent = 'Offline. Your draft is kept; requests are not sent automatically.'; });
  window.addEventListener('online', () => { void refresh(); });
  void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
})();
