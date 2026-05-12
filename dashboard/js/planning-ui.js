(function () {
  let tasks = [];
  let filter = 'all';
  let reminderStop = null;

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

  const priorityLabel = {
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    urgent: 'Urgent',
  };

  const statusLabel = {
    todo: 'To do',
    doing: 'Doing',
    done: 'Done',
  };

  const getFiltered = () => {
    const buckets = window.PlanningStore.buckets(tasks);
    const query = $('taskSearch').value.trim().toLowerCase();
    let list = filter === 'all' ? tasks : buckets[filter] || [];
    if (query) {
      list = list.filter((task) => [task.title, task.notes, task.owner].join(' ').toLowerCase().includes(query));
    }
    return window.PlanningStore.sort(list);
  };

  const pillForDate = (task) => {
    if (!task.dueDate) return '<span class="planning-pill">No date</span>';
    const diff = window.PlanningStore.daysBetween(task.dueDate, window.PlanningStore.todayKey());
    if (task.status === 'done') return '<span class="planning-pill done">Done</span>';
    if (diff < 0) return '<span class="planning-pill overdue">Overdue</span>';
    if (diff === 0) return '<span class="planning-pill today">Today</span>';
    if (diff <= 7) return '<span class="planning-pill">In ' + diff + ' day(s)</span>';
    return '<span class="planning-pill">' + escapeHtml(task.dueDate) + '</span>';
  };

  const renderStats = () => {
    const buckets = window.PlanningStore.buckets(tasks);
    $('stats').innerHTML = [
      ['overdue', 'Overdue', buckets.overdue.length],
      ['today', 'Today', buckets.today.length],
      ['upcoming', 'Upcoming', buckets.upcoming.length],
      ['urgent', 'Urgent', buckets.urgent.length],
    ].map(([key, label, value]) => `
      <article class="planning-stat ${key}">
        <div class="planning-stat-label">${label}</div>
        <div class="planning-stat-value">${value}</div>
      </article>
    `).join('');
    $('listMeta').textContent = buckets.active.length + ' active tasks';
  };

  const renderSummary = () => {
    const buckets = window.PlanningStore.buckets(tasks);
    const next = window.PlanningStore.sort(buckets.overdue)[0]
      || window.PlanningStore.sort(buckets.urgent)[0]
      || window.PlanningStore.sort(buckets.today)[0]
      || window.PlanningStore.sort(buckets.active)[0];

    $('summaryBody').innerHTML = `
      <p><strong>${buckets.active.length}</strong> active task(s), <strong>${buckets.overdue.length}</strong> overdue, <strong>${buckets.today.length}</strong> due today, and <strong>${buckets.upcoming.length}</strong> upcoming within 7 days.</p>
      <p style="margin-top:10px;">Recommended focus: <strong>${next ? escapeHtml(next.title) : 'Add the first planning task'}</strong></p>
      <p style="margin-top:10px;color:var(--t2);">This summary is generated locally from browser storage.</p>
    `;
  };

  const renderList = () => {
    const list = getFiltered();
    if (!list.length) {
      $('taskList').innerHTML = '<div class="planning-empty">No tasks match this view.</div>';
      return;
    }

    $('taskList').innerHTML = list.map((task) => `
      <article class="planning-task ${task.status === 'done' ? 'done' : ''}">
        <input type="checkbox" data-action="toggle" data-id="${task.id}" ${task.status === 'done' ? 'checked' : ''} aria-label="Mark done">
        <div class="planning-task-main">
          <div class="planning-task-title">${escapeHtml(task.title)}</div>
          ${task.notes ? `<div class="planning-task-notes">${escapeHtml(task.notes)}</div>` : ''}
          <div class="planning-task-meta">
            ${pillForDate(task)}
            ${task.dueTime ? `<span class="planning-pill">${escapeHtml(task.dueTime)}</span>` : ''}
            <span class="planning-pill ${task.priority === 'urgent' || task.priority === 'high' ? 'urgent' : ''}">${priorityLabel[task.priority]}</span>
            <span class="planning-pill">${statusLabel[task.status]}</span>
            ${task.owner ? `<span class="planning-pill">${escapeHtml(task.owner)}</span>` : ''}
          </div>
        </div>
        <div class="planning-task-actions">
          <button class="planning-btn icon" data-action="edit" data-id="${task.id}" aria-label="Edit">E</button>
          <button class="planning-btn icon danger" data-action="delete" data-id="${task.id}" aria-label="Delete">x</button>
        </div>
      </article>
    `).join('');
  };

  const renderAll = () => {
    renderStats();
    renderSummary();
    renderList();
  };

  const resetForm = () => {
    $('taskForm').reset();
    $('taskId').value = '';
    $('taskPriority').value = 'normal';
    $('taskStatus').value = 'todo';
    $('formTitle').textContent = 'Add task';
  };

  const formValue = () => ({
    title: $('taskTitle').value,
    dueDate: $('taskDueDate').value,
    dueTime: $('taskDueTime').value,
    priority: $('taskPriority').value,
    status: $('taskStatus').value,
    owner: $('taskOwner').value,
    notes: $('taskNotes').value,
  });

  const editTask = (task) => {
    $('taskId').value = task.id;
    $('taskTitle').value = task.title;
    $('taskDueDate').value = task.dueDate;
    $('taskDueTime').value = task.dueTime;
    $('taskPriority').value = task.priority;
    $('taskStatus').value = task.status;
    $('taskOwner').value = task.owner;
    $('taskNotes').value = task.notes;
    $('formTitle').textContent = 'Edit task';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toast = (message) => {
    const node = document.createElement('div');
    node.className = 'planning-toast';
    node.textContent = message;
    $('toastWrap').appendChild(node);
    window.setTimeout(() => node.remove(), 7000);
  };

  const addAiMessage = (type, text) => {
    const node = document.createElement('div');
    node.className = 'planning-ai-msg ' + type;
    node.textContent = text;
    $('aiLog').appendChild(node);
    $('aiLog').scrollTop = $('aiLog').scrollHeight;
  };

  const bindEvents = () => {
    $('taskForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const id = $('taskId').value;
      if (id) tasks = window.PlanningStore.update(id, formValue());
      else tasks = window.PlanningStore.add(formValue());
      resetForm();
      renderAll();
    });

    $('resetFormBtn').addEventListener('click', resetForm);
    $('taskSearch').addEventListener('input', renderList);

    $('bucketTabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.planning-tab');
      if (!tab) return;
      filter = tab.dataset.filter;
      document.querySelectorAll('.planning-tab').forEach((node) => node.classList.remove('active'));
      tab.classList.add('active');
      renderList();
    });

    $('taskList').addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const task = tasks.find((item) => item.id === target.dataset.id);
      if (!task) return;
      if (target.dataset.action === 'edit') editTask(task);
      if (target.dataset.action === 'delete' && confirm('Delete this task?')) {
        tasks = window.PlanningStore.remove(task.id);
        renderAll();
      }
      if (target.dataset.action === 'toggle') {
        tasks = window.PlanningStore.update(task.id, { status: target.checked ? 'done' : 'todo' });
        renderAll();
      }
    });

    $('openSummaryBtn').addEventListener('click', () => $('summaryModal').classList.add('open'));
    $('closeSummaryBtn').addEventListener('click', () => $('summaryModal').classList.remove('open'));
    $('summaryModal').addEventListener('click', (event) => {
      if (event.target === $('summaryModal')) $('summaryModal').classList.remove('open');
    });

    $('aiToggle').addEventListener('click', () => $('aiPanel').classList.toggle('open'));
    $('aiForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const question = $('aiInput').value.trim();
      addAiMessage('user', question || 'Summary');
      addAiMessage('bot', window.PlanningAI.answer(question, tasks));
      $('aiInput').value = '';
    });
  };

  const init = () => {
    tasks = window.PlanningStore.init();
    bindEvents();
    renderAll();
    addAiMessage('bot', 'I answer from local task data only. Try: what should I focus on today?');
    $('summaryModal').classList.add('open');

    if (reminderStop) reminderStop();
    reminderStop = window.PlanningReminders.start(() => tasks, (message) => toast(message));
  };

  window.PlanningUI = { init };
})();
