(function () {
  let tasks = [];
  let notionPreviewTasks = [];
  let selectedPreviewIds = new Set();
  let taskLookup = new Map();
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
    low: '낮음',
    normal: '보통',
    high: '높음',
    urgent: '긴급',
  };

  const statusLabel = {
    todo: '대기',
    doing: '진행 중',
    done: '완료',
  };

  const sourceLabel = {
    local: '수기 입력',
    'notion-import': 'Notion 가져옴',
  };

  const setTasks = (nextTasks) => {
    tasks = nextTasks;
    taskLookup = new Map(tasks.map((task) => [task.id, task]));
  };

  const getTaskById = (id) => taskLookup.get(id);

  const getPreviewTaskById = (id) => notionPreviewTasks.find((task) => task.id === id);

  const isImportedFromNotion = (task) => task.source === 'notion-import';

  const importedNotionIds = () => new Set(tasks.map((task) => task.notionPageId).filter(Boolean));

  const selectedDateMode = () => {
    const selected = document.querySelector('input[name="notionDateMode"]:checked');
    return selected ? selected.value : 'keep';
  };

  const setBaseDateState = () => {
    const baseDateInput = $('notionBaseDate');
    if (!baseDateInput) return;
    baseDateInput.disabled = selectedDateMode() !== 'base';
  };

  const dateValuesFor = (items) => items
    .flatMap((task) => [task.startDate, task.dueDate])
    .filter(Boolean)
    .sort();

  const shiftDate = (dateKey, dayOffset) => {
    if (!dateKey) return '';
    return window.PlanningStore.addDays(dateKey, dayOffset);
  };

  const applyImportDateMode = (task, selectedTasks) => {
    const mode = selectedDateMode();
    if (mode === 'keep') return { ...task };
    if (mode === 'clear') return { ...task, startDate: '', dueDate: '', dueTime: '' };

    const baseDate = mode === 'today' ? window.PlanningStore.todayKey() : $('notionBaseDate').value;
    const originalDates = dateValuesFor(selectedTasks);
    if (!baseDate || !originalDates.length) return { ...task };

    const dayOffset = window.PlanningStore.daysBetween(baseDate, originalDates[0]);
    return {
      ...task,
      startDate: shiftDate(task.startDate, dayOffset),
      dueDate: shiftDate(task.dueDate, dayOffset),
    };
  };

  const getFiltered = () => {
    const buckets = window.PlanningStore.buckets(tasks);
    const query = $('taskSearch').value.trim().toLowerCase();
    let list = filter === 'all' ? tasks : buckets[filter] || [];
    if (query) {
      list = list.filter((task) => [task.title, task.notes, task.owner, task.project, task.phase].join(' ').toLowerCase().includes(query));
    }
    return window.PlanningStore.sort(list);
  };

  const taskTone = (task) => {
    const diff = task.dueDate ? window.PlanningStore.daysBetween(task.dueDate, window.PlanningStore.todayKey()) : 99;
    if (task.status === 'done') return 'done';
    if (diff < 0) return 'overdue';
    if (task.priority === 'urgent' || task.priority === 'high') return 'urgent';
    if (task.status === 'doing') return 'doing';
    return 'normal';
  };

  const pillForDate = (task) => {
    if (!task.dueDate) return '<span class="planning-pill">기한 없음</span>';
    const diff = window.PlanningStore.daysBetween(task.dueDate, window.PlanningStore.todayKey());
    if (task.status === 'done') return '<span class="planning-pill done">완료</span>';
    if (diff < 0) return '<span class="planning-pill overdue">지연</span>';
    if (diff === 0) return '<span class="planning-pill today">오늘</span>';
    if (diff <= 7) return '<span class="planning-pill">' + diff + '일 후</span>';
    return '<span class="planning-pill">' + escapeHtml(task.dueDate) + '</span>';
  };

  const dependencyText = (task) => {
    const lookup = task.source === 'notion-preview' ? getPreviewTaskById : getTaskById;
    const depends = task.dependsOnTaskIds.map(lookup).filter(Boolean).map((item) => item.title);
    const related = task.relatedTaskIds.map(lookup).filter(Boolean).map((item) => item.title);
    const parts = [];
    if (depends.length) parts.push('선행: ' + depends.join(', '));
    if (related.length) parts.push('관련: ' + related.join(', '));
    return parts.join(' / ');
  };

  const renderStats = () => {
    const buckets = window.PlanningStore.buckets(tasks);
    $('stats').innerHTML = [
      ['overdue', '지연 업무', buckets.overdue.length, '기한 경과'],
      ['today', '오늘 할 일', buckets.today.length, '당일 처리'],
      ['upcoming', '예정 업무', buckets.upcoming.length, '7일 내'],
      ['urgent', '긴급 업무', buckets.urgent.length, '우선 확인'],
    ].map(([key, label, value, sub]) => `
      <article class="planning-stat ${key}">
        <div class="planning-stat-label">${label}</div>
        <div class="planning-stat-value">${value}</div>
        <div class="planning-stat-sub">${sub}</div>
      </article>
    `).join('');
    $('listMeta').textContent = '진행 업무 ' + buckets.active.length + '건';
  };

  const renderSummary = () => {
    const buckets = window.PlanningStore.buckets(tasks);
    const next = window.PlanningStore.sort(buckets.overdue)[0]
      || window.PlanningStore.sort(buckets.urgent)[0]
      || window.PlanningStore.sort(buckets.today)[0]
      || window.PlanningStore.sort(buckets.active)[0];

    $('summaryBody').innerHTML = `
      <p>진행 업무 <strong>${buckets.active.length}</strong>건, 지연 업무 <strong>${buckets.overdue.length}</strong>건, 오늘 할 일 <strong>${buckets.today.length}</strong>건, 7일 내 예정 업무 <strong>${buckets.upcoming.length}</strong>건입니다.</p>
      <p style="margin-top:10px;">권장 집중 업무: <strong>${next ? escapeHtml(next.title) : '첫 계획 업무를 추가하세요'}</strong></p>
      <p style="margin-top:10px;color:var(--t2);">이 요약은 브라우저 로컬 저장소 기준으로 생성됩니다.</p>
    `;
  };

  const renderList = () => {
    const list = getFiltered();
    if (!list.length) {
      $('taskList').innerHTML = '<div class="planning-empty">이 보기와 일치하는 업무가 없습니다.</div>';
      return;
    }

    $('taskList').innerHTML = list.map((task) => {
      const relation = dependencyText(task);
      return `
        <article class="planning-task ${task.status === 'done' ? 'done' : ''} ${taskTone(task)}">
          <input type="checkbox" data-action="toggle" data-id="${task.id}" ${task.status === 'done' ? 'checked' : ''} aria-label="완료 처리">
          <div class="planning-task-main">
            <div class="planning-task-topline">
              <div class="planning-task-title">${escapeHtml(task.title)}</div>
              <span class="planning-task-project">${escapeHtml(task.project)}</span>
            </div>
            ${task.notes ? `<div class="planning-task-notes">${escapeHtml(task.notes)}</div>` : ''}
            <div class="planning-task-meta">
              ${pillForDate(task)}
              ${task.startDate ? `<span class="planning-pill">시작 ${escapeHtml(task.startDate)}</span>` : ''}
              ${task.dueTime ? `<span class="planning-pill">${escapeHtml(task.dueTime)}</span>` : ''}
              <span class="planning-pill ${task.priority === 'urgent' || task.priority === 'high' ? 'urgent' : ''}">${priorityLabel[task.priority]}</span>
              <span class="planning-pill">${statusLabel[task.status]}</span>
              ${task.phase ? `<span class="planning-pill">${escapeHtml(task.phase)}</span>` : ''}
              ${task.owner ? `<span class="planning-pill">${escapeHtml(task.owner)}</span>` : ''}
              <span class="planning-pill ${isImportedFromNotion(task) ? 'imported' : 'local'}">${sourceLabel[task.source] || '수기 입력'}</span>
            </div>
            ${relation ? `<div class="planning-task-relations">${escapeHtml(relation)}</div>` : ''}
          </div>
          <div class="planning-task-actions">
            <button class="planning-btn compact" data-action="edit" data-id="${task.id}" aria-label="수정">수정</button>
            <button class="planning-btn compact danger" data-action="delete" data-id="${task.id}" aria-label="삭제">삭제</button>
          </div>
        </article>
      `;
    }).join('');
  };

  const renderNotionPreview = () => {
    const statusNode = $('notionPreviewStatus');
    const listNode = $('notionPreviewList');
    if (!statusNode || !listNode) return;

    if (!notionPreviewTasks.length) {
      listNode.innerHTML = '';
      statusNode.textContent = '아직 불러오지 않았습니다.';
      $('importSelectedNotionBtn').disabled = true;
      return;
    }

    const importedIds = importedNotionIds();
    const availableCount = notionPreviewTasks.filter((task) => !importedIds.has(task.notionPageId)).length;
    const selectedCount = [...selectedPreviewIds].filter((id) => !importedIds.has(getPreviewTaskById(id)?.notionPageId)).length;
    statusNode.textContent = 'Notion 작업 ' + notionPreviewTasks.length + '건 중 ' + availableCount + '건을 가져올 수 있습니다. 선택 ' + selectedCount + '건.';
    $('importSelectedNotionBtn').disabled = selectedCount === 0;
    listNode.innerHTML = window.PlanningStore.sort(notionPreviewTasks).map((task) => {
      const relation = dependencyText(task);
      const rawRefs = task.relationRefs || {};
      const relationCount = (rawRefs.dependsOnUrls || []).length + (rawRefs.relatedUrls || []).length;
      const imported = importedIds.has(task.notionPageId);
      const checked = selectedPreviewIds.has(task.id) && !imported;
      return `
        <article class="planning-task notion-preview-task ${imported ? 'already-imported' : ''} ${taskTone(task)}">
          <label class="notion-preview-check">
            <input type="checkbox" data-action="select-preview" data-id="${task.id}" ${checked ? 'checked' : ''} ${imported ? 'disabled' : ''} aria-label="가져올 항목 선택">
            <span>${imported ? '가져옴' : '선택'}</span>
          </label>
          <div class="planning-task-main">
            <div class="planning-task-topline">
              <div class="planning-task-title">${escapeHtml(task.title)}</div>
              <span class="planning-task-project">${escapeHtml(task.project)}</span>
            </div>
            ${task.notes ? `<div class="planning-task-notes">${escapeHtml(task.notes)}</div>` : ''}
            <div class="planning-task-meta">
              ${pillForDate(task)}
              ${task.startDate ? `<span class="planning-pill">시작 ${escapeHtml(task.startDate)}</span>` : ''}
              <span class="planning-pill ${task.priority === 'urgent' || task.priority === 'high' ? 'urgent' : ''}">${priorityLabel[task.priority]}</span>
              <span class="planning-pill">${statusLabel[task.status]}</span>
              <span class="planning-pill notion">Notion 미리보기</span>
              ${imported ? '<span class="planning-pill imported">이미 가져온 항목</span>' : ''}
              ${relationCount ? `<span class="planning-pill">관계 ${relationCount}건</span>` : ''}
            </div>
            ${relation ? `<div class="planning-task-relations">${escapeHtml(relation)}</div>` : ''}
          </div>
          <div class="planning-task-actions">
            <a class="planning-btn compact" href="${escapeHtml(task.notionUrl)}" target="_blank" rel="noopener">Notion 열기</a>
          </div>
        </article>
      `;
    }).join('');
  };

  const loadNotionPreview = async () => {
    const statusNode = $('notionPreviewStatus');
    const button = $('loadNotionPreviewBtn');
    if (!window.PlanningNotionPreview || !statusNode || !button) return;

    statusNode.innerHTML = '<span class="loading-spinner small"></span> Notion 미리보기를 준비 중입니다.';
    button.disabled = true;
    try {
      notionPreviewTasks = await window.PlanningNotionPreview.load();
      selectedPreviewIds = new Set();
      renderNotionPreview();
    } catch (error) {
      console.warn('Notion preview load failed', error);
      statusNode.textContent = 'Notion 미리보기를 불러오지 못했습니다. 연결 상태를 확인해 주세요.';
    } finally {
      button.disabled = false;
    }
  };

  const importSelectedNotionTasks = () => {
    if (!notionPreviewTasks.length) {
      toast('먼저 Notion 미리보기를 불러와 주세요.');
      return;
    }

    const importedIds = importedNotionIds();
    const selectedTasks = notionPreviewTasks.filter((task) => selectedPreviewIds.has(task.id));
    if (!selectedTasks.length) {
      toast('가져올 항목을 선택해 주세요.');
      return;
    }
    if (selectedDateMode() === 'base' && !$('notionBaseDate').value) {
      toast('일정을 이동할 기준일을 선택해 주세요.');
      return;
    }

    let importedCount = 0;
    let skippedCount = 0;
    let nextTasks = tasks;
    selectedTasks.forEach((task) => {
      if (importedIds.has(task.notionPageId)) {
        skippedCount += 1;
        return;
      }
      const adjustedTask = applyImportDateMode(task, selectedTasks);
      nextTasks = window.PlanningStore.add({
        ...adjustedTask,
        id: task.id,
        owner: task.owner === 'Notion' ? '' : task.owner,
        source: 'notion-import',
        importedAt: new Date().toISOString(),
      });
      importedIds.add(task.notionPageId);
      importedCount += 1;
    });

    setTasks(nextTasks);
    selectedPreviewIds = new Set();
    renderAll();
    renderNotionPreview();

    if (importedCount && skippedCount) toast(importedCount + '건을 가져왔고, ' + skippedCount + '건은 이미 가져온 항목입니다.');
    else if (importedCount) toast('선택한 Notion 항목 ' + importedCount + '건을 내 계획으로 가져왔습니다.');
    else toast('이미 가져온 항목입니다.');
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
    $('formTitle').textContent = '업무 추가';
  };

  const formValue = () => ({
    title: $('taskTitle').value,
    project: $('taskProject').value,
    phase: $('taskPhase').value,
    startDate: $('taskStartDate').value,
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
    $('taskProject').value = task.project;
    $('taskPhase').value = task.phase;
    $('taskStartDate').value = task.startDate;
    $('taskDueDate').value = task.dueDate;
    $('taskDueTime').value = task.dueTime;
    $('taskPriority').value = task.priority;
    $('taskStatus').value = task.status;
    $('taskOwner').value = task.owner;
    $('taskNotes').value = task.notes;
    $('formTitle').textContent = '업무 수정';
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
      if (id) setTasks(window.PlanningStore.update(id, formValue()));
      else setTasks(window.PlanningStore.add(formValue()));
      resetForm();
      renderAll();
    });

    $('resetFormBtn').addEventListener('click', resetForm);
    $('taskSearch').addEventListener('input', renderList);
    $('loadNotionPreviewBtn').addEventListener('click', loadNotionPreview);
    $('importSelectedNotionBtn').addEventListener('click', importSelectedNotionTasks);
    document.querySelectorAll('input[name="notionDateMode"]').forEach((node) => {
      node.addEventListener('change', setBaseDateState);
    });

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
      if (target.dataset.action === 'delete' && confirm('이 업무를 삭제하시겠습니까?')) {
        setTasks(window.PlanningStore.remove(task.id));
        renderAll();
      }
      if (target.dataset.action === 'toggle') {
        setTasks(window.PlanningStore.update(task.id, { status: target.checked ? 'done' : 'todo' }));
        renderAll();
      }
    });

    $('notionPreviewList').addEventListener('change', (event) => {
      const target = event.target.closest('[data-action="select-preview"]');
      if (!target) return;
      if (target.checked) selectedPreviewIds.add(target.dataset.id);
      else selectedPreviewIds.delete(target.dataset.id);
      renderNotionPreview();
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
      addAiMessage('user', question || '요약');
      addAiMessage('bot', window.PlanningAI.answer(question, tasks));
      $('aiInput').value = '';
    });
  };

  const init = () => {
    setTasks(window.PlanningStore.init());
    bindEvents();
    setBaseDateState();
    renderAll();
    renderNotionPreview();
    addAiMessage('bot', '로컬 업무 데이터만 기준으로 답변합니다. 예: 오늘 무엇에 집중할까?');
    $('summaryModal').classList.add('open');

    if (reminderStop) reminderStop();
    reminderStop = window.PlanningReminders.start(() => tasks, (message) => toast(message));
  };

  window.PlanningUI = { init };
})();
