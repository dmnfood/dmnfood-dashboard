(function () {
  let tasks = [];
  let taskLookup = new Map();
  let filter = 'all';
  let reminderStop = null;
  let timelineRenderToken = 0;
  const timelineCache = {
    signature: '',
    model: null,
  };

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

  const setTasks = (nextTasks) => {
    tasks = nextTasks;
    taskLookup = new Map(tasks.map((task) => [task.id, task]));
  };

  const getTaskById = (id) => taskLookup.get(id);

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
    const depends = task.dependsOnTaskIds.map(getTaskById).filter(Boolean).map((item) => item.title);
    const related = task.relatedTaskIds.map(getTaskById).filter(Boolean).map((item) => item.title);
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

  const formatDate = (dateKey) => {
    const date = new Date(dateKey + 'T00:00:00');
    return date;
  };

  const formatDay = (dateKey) => String(formatDate(dateKey).getDate()).padStart(2, '0');

  const formatWeekday = (dateKey) => {
    const date = formatDate(dateKey);
    return ['일', '월', '화', '수', '목', '금', '토'][date.getDay()];
  };

  const monthKey = (dateKey) => dateKey.slice(0, 7);
  const weekStart = (dateKey) => {
    const date = formatDate(dateKey);
    const day = date.getDay();
    date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
    return date.toISOString().slice(0, 10);
  };

  const makeTimelineSignature = () => tasks.map((task) => [
    task.id,
    task.title,
    task.project,
    task.phase,
    task.startDate,
    task.dueDate,
    task.status,
    task.priority,
    task.updatedAt,
    task.dependsOnTaskIds.join('|'),
    task.relatedTaskIds.join('|'),
  ].join('~')).join('||');

  const rangeDays = (start, end) => Math.max(window.PlanningStore.daysBetween(end, start), 0);

  const addMonths = (dateKey, months) => {
    const date = formatDate(dateKey);
    date.setMonth(date.getMonth() + months);
    return date.toISOString().slice(0, 10);
  };

  const getTimelineScale = (minDate, maxDate) => {
    const span = rangeDays(minDate, maxDate);
    if (span <= 45) return 'day';
    if (span <= 210) return 'week';
    return 'month';
  };

  const buildUnits = (scale, minDate, maxDate) => {
    const today = window.PlanningStore.todayKey();
    const units = [];
    let start;
    let end;

    if (scale === 'day') {
      start = window.PlanningStore.addDays(today, -14);
      end = window.PlanningStore.addDays(today, 28);
      if (rangeDays(minDate, maxDate) <= 45) {
        start = window.PlanningStore.addDays(minDate, -2);
        end = window.PlanningStore.addDays(maxDate, 4);
      }
      for (let current = start; current <= end; current = window.PlanningStore.addDays(current, 1)) {
        units.push({ key: current, start: current, end: current, label: formatDay(current), sub: formatWeekday(current) });
      }
    } else if (scale === 'week') {
      start = weekStart(window.PlanningStore.addDays(today, -35));
      end = window.PlanningStore.addDays(start, 7 * 15);
      for (let current = start; current <= end; current = window.PlanningStore.addDays(current, 7)) {
        units.push({
          key: current,
          start: current,
          end: window.PlanningStore.addDays(current, 6),
          label: monthKey(current),
          sub: formatDay(current) + '주',
        });
      }
    } else {
      start = addMonths(today.slice(0, 7) + '-01', -2);
      end = addMonths(start, 8);
      for (let current = start; current <= end; current = addMonths(current, 1)) {
        const next = addMonths(current, 1);
        units.push({
          key: current,
          start: current,
          end: window.PlanningStore.addDays(next, -1),
          label: current.slice(0, 7),
          sub: '월',
        });
      }
    }

    return { units, start, end };
  };

  const overlaps = (task, windowStart, windowEnd) => {
    const start = task.startDate || task.dueDate;
    const end = task.dueDate || task.startDate;
    if (!start && !end) return false;
    return (start || end) <= windowEnd && (end || start) >= windowStart;
  };

  const getUnitIndex = (units, dateKey, fallback) => {
    if (!dateKey) return fallback;
    const index = units.findIndex((unit) => dateKey >= unit.start && dateKey <= unit.end);
    return index >= 0 ? index + 1 : fallback;
  };

  const getTimelineModel = () => {
    const signature = makeTimelineSignature();
    if (timelineCache.signature === signature && timelineCache.model) return timelineCache.model;

    const sortedTasks = window.PlanningStore.sort(tasks);
    const dated = sortedTasks.flatMap((task) => [task.startDate, task.dueDate]).filter(Boolean).sort();
    const today = window.PlanningStore.todayKey();
    const minDate = dated[0] || today;
    const maxDate = dated[dated.length - 1] || today;
    const scale = getTimelineScale(minDate, maxDate);
    const { units, start, end } = buildUnits(scale, minDate, maxDate);
    const windowTasks = sortedTasks.filter((task) => overlaps(task, start, end));
    const maxVisibleTasks = 120;
    const visibleTasks = windowTasks.slice(0, maxVisibleTasks);
    const groups = window.PlanningStore.groupByProject(visibleTasks);

    timelineCache.signature = signature;
    timelineCache.model = {
      groups,
      hiddenCount: sortedTasks.length - visibleTasks.length,
      scale,
      start,
      end,
      today,
      units,
      colCount: units.length,
    };
    return timelineCache.model;
  };

  const setTimelineLoading = () => {
    const timeline = $('timeline');
    if (!timeline) return;
    timeline.innerHTML = '<div class="timeline-loading"><div class="loading-spinner small"></div><span>타임라인을 준비하는 중입니다.</span></div>';
  };

  const appendText = (parent, tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  };

  const renderTimelineModel = (model, token) => {
    if (token !== timelineRenderToken) return;
    const timeline = $('timeline');
    if (!timeline) return;

    if (!tasks.length || !model.groups.length) {
      timeline.innerHTML = '<div class="planning-empty">현재 날짜 창에 표시할 업무가 없습니다.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    const left = document.createElement('div');
    const scroll = document.createElement('div');
    const leftBody = document.createElement('div');
    const axis = document.createElement('div');
    const grid = document.createElement('div');

    left.className = 'timeline-left';
    scroll.className = 'timeline-scroll';
    leftBody.className = 'timeline-left-body';
    axis.className = 'timeline-axis';
    axis.style.gridTemplateColumns = `repeat(${model.colCount}, var(--timeline-unit-width))`;
    grid.className = 'timeline-grid';
    grid.style.setProperty('--timeline-cols', model.colCount);

    appendText(left, 'div', 'timeline-left-head', '업무 그룹');

    model.units.forEach((unit) => {
      const day = document.createElement('div');
      day.className = 'timeline-day' + (model.today >= unit.start && model.today <= unit.end ? ' today' : '');
      appendText(day, 'span', '', unit.label);
      appendText(day, 'small', '', unit.sub);
      axis.appendChild(day);
    });

    const todayIndex = getUnitIndex(model.units, model.today, 1);
    const todayMarker = document.createElement('div');
    todayMarker.className = 'timeline-today-marker';
    todayMarker.style.left = `calc(${Math.max(todayIndex - 1, 0)} * var(--timeline-unit-width))`;
    grid.appendChild(todayMarker);

    model.groups.forEach((group) => {
      const groupRow = document.createElement('div');
      groupRow.className = 'timeline-group-row';
      appendText(groupRow, 'strong', '', group.project);
      appendText(groupRow, 'span', '', group.items.length + '건');
      leftBody.appendChild(groupRow);

      const groupGridRow = document.createElement('div');
      groupGridRow.className = 'timeline-grid-row group';
      groupGridRow.style.gridTemplateColumns = `repeat(${model.colCount}, var(--timeline-unit-width))`;
      grid.appendChild(groupGridRow);

      group.items.forEach((task) => {
        const start = getUnitIndex(model.units, task.startDate || task.dueDate, 1);
        const end = getUnitIndex(model.units, task.dueDate || task.startDate, start);
        const startCol = Math.min(start, end);
        const span = Math.max(Math.abs(end - start) + 1, 1);
        const relation = dependencyText(task);
        const dependsLabels = task.dependsOnTaskIds.map(getTaskById).filter(Boolean).map((item) => item.title).join(', ');

        const leftRow = document.createElement('div');
        leftRow.className = 'timeline-left-row';
        leftRow.dataset.taskId = task.id;
        appendText(leftRow, 'div', 'timeline-left-title', task.title);
        const meta = document.createElement('div');
        meta.className = 'timeline-left-meta';
        appendText(meta, 'span', 'planning-pill ' + taskTone(task), statusLabel[task.status]);
        appendText(meta, 'span', '', task.phase || '실행');
        leftRow.appendChild(meta);
        leftBody.appendChild(leftRow);

        const gridRow = document.createElement('div');
        gridRow.className = 'timeline-grid-row';
        gridRow.dataset.taskId = task.id;
        gridRow.style.gridTemplateColumns = `repeat(${model.colCount}, var(--timeline-unit-width))`;

        const bar = document.createElement('div');
        bar.className = 'timeline-bar ' + taskTone(task);
        bar.style.gridColumn = `${startCol} / span ${span}`;
        bar.dataset.taskId = task.id;
        bar.dataset.dependsOn = task.dependsOnTaskIds.join(',');
        bar.dataset.related = task.relatedTaskIds.join(',');
        bar.title = relation || task.title;
        appendText(bar, 'span', 'timeline-bar-title', task.title);
        appendText(bar, 'span', 'timeline-bar-status', statusLabel[task.status]);
        if (task.dependsOnTaskIds.length) {
          const dep = appendText(bar, 'span', 'timeline-dependency', '선행 ' + task.dependsOnTaskIds.length);
          dep.title = '선행 업무: ' + dependsLabels;
        }

        gridRow.appendChild(bar);
        grid.appendChild(gridRow);
      });
    });

    if (model.hiddenCount > 0) {
      const note = appendText(leftBody, 'div', 'timeline-window-note', '현재 창 밖 업무 ' + model.hiddenCount + '건');
      note.title = model.start + ' ~ ' + model.end + ' 범위만 표시 중';
      const blank = document.createElement('div');
      blank.className = 'timeline-grid-row note';
      grid.appendChild(blank);
    }

    left.appendChild(leftBody);
    scroll.appendChild(axis);
    scroll.appendChild(grid);
    fragment.appendChild(left);
    fragment.appendChild(scroll);

    timeline.replaceChildren(fragment);
  };

  const scheduleTimelineRender = () => {
    const token = ++timelineRenderToken;
    setTimelineLoading();
    const run = () => {
      const model = getTimelineModel();
      renderTimelineModel(model, token);
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 300 });
    } else {
      window.setTimeout(run, 40);
    }
  };

  const renderAll = () => {
    renderStats();
    renderSummary();
    renderList();
    scheduleTimelineRender();
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
    renderAll();
    addAiMessage('bot', '로컬 업무 데이터만 기준으로 답변합니다. 예: 오늘 무엇에 집중할까?');
    $('summaryModal').classList.add('open');

    if (reminderStop) reminderStop();
    reminderStop = window.PlanningReminders.start(() => tasks, (message) => toast(message));
  };

  window.PlanningUI = { init };
})();
