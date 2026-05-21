(function () {
  let tasks = [];
  let notionPreviewTasks = [];
  let selectedPreviewIds = new Set();
  let exportAnalysis = null;
  let lastBriefingSections = null;
  let mermaidPromise = null;
  let mermaidRenderSeq = 0;
  let taskLookup = new Map();
  let activeWorkArea = '전체';
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
    todo: '시작 전',
    doing: '진행 중',
    review: '확인 필요',
    done: '완료',
  };

  const sourceLabel = {
    local: '수기 입력',
    'notion-import': 'Notion 가져옴',
    'notion-export-import': 'Export 가져옴',
  };

  const setTasks = (nextTasks) => {
    tasks = nextTasks;
    taskLookup = new Map(tasks.map((task) => [task.id, task]));
  };

  const getTaskById = (id) => taskLookup.get(id);

  const getPreviewTaskById = (id) => notionPreviewTasks.find((task) => task.id === id);

  const isImportedFromNotion = (task) => task.source === 'notion-import' || task.source === 'notion-export-import';

  const importedNotionIds = () => new Set(tasks.map((task) => task.notionPageId).filter(Boolean));

  const workAreaMatches = (task) => activeWorkArea === '전체' || task.workArea === activeWorkArea;

  const currentBaseTasks = () => tasks.filter(workAreaMatches);

  const selectedFilterValue = (id) => ($(id) ? $(id).value : 'all');

  const applyStructuredFilters = (items) => {
    const project = selectedFilterValue('projectFilter');
    const status = selectedFilterValue('statusFilter');
    const priority = selectedFilterValue('priorityFilter');
    return items.filter((task) => {
      if (project !== 'all' && task.project !== project) return false;
      if (status !== 'all' && task.status !== status) return false;
      if (priority !== 'all' && task.priority !== priority) return false;
      return true;
    });
  };

  const visibleTasks = () => applyStructuredFilters(currentBaseTasks());

  const updateProjectFilter = () => {
    const projectFilter = $('projectFilter');
    if (!projectFilter) return;
    const current = projectFilter.value;
    const projects = [...new Set(currentBaseTasks().map((task) => task.project).filter(Boolean))].sort();
    projectFilter.innerHTML = '<option value="all">전체 프로젝트</option>' + projects.map((project) => (
      `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`
    )).join('');
    projectFilter.value = projects.includes(current) ? current : 'all';
  };

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

  const selectedZipFile = () => {
    const input = $('notionExportZipInput');
    return input && input.files && input.files[0] ? input.files[0] : null;
  };

  const renderExportSummary = () => {
    const summaryNode = $('exportImportSummary');
    if (!summaryNode) return;
    if (!exportAnalysis) {
      summaryNode.textContent = 'Notion에서 내보낸 ZIP 파일을 선택하면 가져오기 후보를 미리 확인합니다.';
      return;
    }
    summaryNode.innerHTML = [
      '분석 파일: ' + escapeHtml(selectedZipFile()?.name || 'Notion Export ZIP'),
      '작업 CSV ' + exportAnalysis.totalTaskRows + '건 중 ERP 후보 ' + exportAnalysis.importedTaskCandidates + '건',
      '프로젝트 ' + exportAnalysis.projectCount + '건, 관련 프로젝트 ' + exportAnalysis.erpProjectCount + '건',
      'markdown 문서 ' + exportAnalysis.markdownCount + '개 연결',
      exportAnalysis.ignoredTaskRows ? '제외된 비 ERP 후보 ' + exportAnalysis.ignoredTaskRows + '건' : '제외된 항목 없음',
    ].map((item) => `<span>${item}</span>`).join(' · ');
  };

  const updateExportFileLabel = () => {
    const file = selectedZipFile();
    const label = document.querySelector('.export-file-label');
    if (label) label.textContent = file ? file.name : 'ZIP 선택';
  };

  const getFiltered = () => {
    const buckets = window.PlanningStore.buckets(visibleTasks());
    const query = $('taskSearch').value.trim().toLowerCase();
    let list = filter === 'all' ? visibleTasks() : buckets[filter] || [];
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
    if (task.status === 'doing' || task.status === 'review') return 'doing';
    return 'normal';
  };

  const labelForTask = (task) => task
    ? [task.project, task.phase, task.dueDate || '기한 없음'].filter(Boolean).join(' · ')
    : '표시할 업무 없음';

  const topFocusTask = (items) => {
    const buckets = window.PlanningStore.buckets(items);
    return window.PlanningStore.sort(buckets.overdue)[0]
      || window.PlanningStore.sort(buckets.urgent)[0]
      || window.PlanningStore.sort(buckets.today)[0]
      || window.PlanningStore.sort(buckets.active)[0]
      || window.PlanningStore.sort(items)[0]
      || null;
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
    const buckets = window.PlanningStore.buckets(visibleTasks());
    $('stats').innerHTML = [
      ['overdue', '지연 업무', buckets.overdue.length, '기한 경과'],
      ['today', '오늘 할 일', buckets.today.length, '당일 처리'],
      ['upcoming', '예정 업무', buckets.upcoming.length, '7일 내'],
      ['urgent', '주간 집중 업무', buckets.urgent.length, '우선 확인'],
    ].map(([key, label, value, sub]) => `
      <article class="planning-stat ${key}">
        <div class="planning-stat-label">${label}</div>
        <div class="planning-stat-value">${value}</div>
        <div class="planning-stat-sub">${sub}</div>
      </article>
    `).join('');
    $('listMeta').textContent = activeWorkArea + ' 업무 ' + visibleTasks().length + '건';
  };

  const renderSummary = () => {
    const buckets = window.PlanningStore.buckets(visibleTasks());
    const next = window.PlanningStore.sort(buckets.overdue)[0]
      || window.PlanningStore.sort(buckets.urgent)[0]
      || window.PlanningStore.sort(buckets.today)[0]
      || window.PlanningStore.sort(buckets.active)[0];

    $('summaryBody').innerHTML = `
      <p><strong>${escapeHtml(activeWorkArea)}</strong> 기준 진행 업무 <strong>${buckets.active.length}</strong>건, 지연 업무 <strong>${buckets.overdue.length}</strong>건, 오늘 할 일 <strong>${buckets.today.length}</strong>건, 7일 내 예정 업무 <strong>${buckets.upcoming.length}</strong>건입니다.</p>
      <p style="margin-top:10px;">권장 집중 업무: <strong>${next ? escapeHtml(next.title) : '첫 계획 업무를 추가하세요'}</strong></p>
      <p style="margin-top:10px;color:var(--t2);">이 요약은 브라우저 로컬 저장소 기준으로 생성됩니다.</p>
    `;
  };

  const renderMissionControl = () => {
    const container = $('missionControl');
    if (!container) return;
    const items = visibleTasks();
    const buckets = window.PlanningStore.buckets(items);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const focus = topFocusTask(items);
    const bottleneck = window.PlanningStore.sort(items.filter((task) => (
      task.status !== 'done'
      && (taskTone(task) === 'overdue' || task.priority === 'urgent' || task.dependsOnTaskIds.some((id) => byId.get(id)?.status !== 'done'))
    )))[0] || focus;
    const prereq = focus
      ? focus.dependsOnTaskIds.map((id) => byId.get(id)).find((task) => task && task.status !== 'done')
      : null;
    const aiAction = lastBriefingSections?.['추천 행동']?.[0]
      || (buckets.overdue.length ? '지연 업무를 먼저 분해하고 담당/기한을 재확정하세요.' : '오늘 처리할 핵심 업무 1건을 완료 상태로 만드는 데 집중하세요.');

    const cards = [
      ['지금 해야 할 핵심 업무', focus?.title || '업무 없음', labelForTask(focus), 'primary'],
      ['가장 위험한 병목', bottleneck?.title || '병목 없음', bottleneck ? labelForTask(bottleneck) : '현재 조건에서 위험 병목이 없습니다.', 'risk'],
      ['다음 선행 필요 작업', prereq?.title || '선행 업무 없음', prereq ? labelForTask(prereq) : '바로 착수 가능한 업무 흐름입니다.', ''],
      ['AI 추천 행동', aiAction.replace(/^[-•]\s*/, ''), lastBriefingSections ? '최근 AI 브리핑 기준' : '로컬 업무 현황 기준', 'action'],
    ];

    container.innerHTML = cards.map(([label, title, meta, tone]) => `
      <article class="mission-card ${tone}">
        <div class="mission-label">${escapeHtml(label)}</div>
        <div class="mission-title">${escapeHtml(title)}</div>
        <div class="mission-meta">${escapeHtml(meta)}</div>
      </article>
    `).join('');
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
    const sourceNote = $('notionSourceNote');
    if (sourceNote) {
      sourceNote.textContent = exportAnalysis
        ? '현재 소스: 업로드한 Notion Export ZIP. ERP/운영 계획 항목만 로컬 가져오기 후보로 표시합니다.'
        : '현재 소스: Notion Export ZIP. 내장 ERP 미리보기는 테스트용 보조 데이터입니다.';
    }

    if (!notionPreviewTasks.length) {
      listNode.innerHTML = '';
      statusNode.textContent = '아직 분석된 가져오기 후보가 없습니다.';
      $('importSelectedNotionBtn').disabled = true;
      return;
    }

    const scopedPreviewTasks = notionPreviewTasks.filter((task) => activeWorkArea === '전체' || task.workArea === activeWorkArea);
    if (!scopedPreviewTasks.length) {
      listNode.innerHTML = '';
      statusNode.textContent = activeWorkArea + ' 영역에서 표시할 Export 가져오기 후보가 없습니다. 이번 가져오기는 ERP 업무영역 기준입니다.';
      $('importSelectedNotionBtn').disabled = true;
      return;
    }

    const importedIds = importedNotionIds();
    const availableCount = scopedPreviewTasks.filter((task) => !importedIds.has(task.notionPageId)).length;
    const scopedPreviewIds = new Set(scopedPreviewTasks.map((task) => task.id));
    const selectedCount = [...selectedPreviewIds].filter((id) => scopedPreviewIds.has(id) && !importedIds.has(getPreviewTaskById(id)?.notionPageId)).length;
    statusNode.textContent = '가져오기 후보 ' + scopedPreviewTasks.length + '건 중 ' + availableCount + '건을 가져올 수 있습니다. 선택 ' + selectedCount + '건.';
    $('importSelectedNotionBtn').disabled = selectedCount === 0;
    listNode.innerHTML = window.PlanningStore.sort(scopedPreviewTasks).map((task) => {
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
              <span class="planning-pill notion">${task.source === 'notion-export-preview' ? 'Export 미리보기' : 'Notion 미리보기'}</span>
              ${imported ? '<span class="planning-pill imported">이미 가져온 항목</span>' : ''}
              ${relationCount ? `<span class="planning-pill">관계 ${relationCount}건</span>` : ''}
            </div>
            ${relation ? `<div class="planning-task-relations">${escapeHtml(relation)}</div>` : ''}
          </div>
          <div class="planning-task-actions">
            ${task.notionUrl ? `<a class="planning-btn compact" href="${escapeHtml(task.notionUrl)}" target="_blank" rel="noopener">Notion 열기</a>` : '<span class="planning-pill notion">ZIP 원본</span>'}
          </div>
        </article>
      `;
    }).join('');
  };

  const dependencyCount = (task) => task.dependsOnTaskIds.length + task.relatedTaskIds.length;

  const compactTaskCard = (task) => `
    <article class="flow-card ${taskTone(task)}">
      <div class="flow-card-title">${escapeHtml(task.title)}</div>
      <div class="flow-card-project">${escapeHtml(task.project || '일반 업무')}</div>
      <div class="planning-task-meta">
        ${task.phase ? `<span class="planning-pill">${escapeHtml(task.phase)}</span>` : ''}
        ${task.dueDate ? `<span class="planning-pill">${escapeHtml(task.dueDate)}</span>` : '<span class="planning-pill">기한 없음</span>'}
        <span class="planning-pill ${task.priority === 'urgent' || task.priority === 'high' ? 'urgent' : ''}">${priorityLabel[task.priority]}</span>
        <span class="planning-pill ${isImportedFromNotion(task) ? 'imported' : 'local'}">${sourceLabel[task.source] || '수기 입력'}</span>
        ${dependencyCount(task) ? `<span class="planning-pill">관계 ${dependencyCount(task)}건</span>` : ''}
      </div>
    </article>
  `;

  const renderFlowBoard = () => {
    const board = $('flowBoard');
    if (!board) return;
    const items = window.PlanningStore.sort(visibleTasks());
    const columns = [
      ['todo', '시작 전'],
      ['doing', '진행 중'],
      ['review', '확인 필요'],
      ['done', '완료'],
    ];

    board.innerHTML = columns.map(([status, label]) => {
      const columnTasks = items.filter((task) => task.status === status).slice(0, 8);
      return `
        <section class="flow-column">
          <div class="flow-column-head">
            <span>${label}</span>
            <b>${items.filter((task) => task.status === status).length}</b>
          </div>
          <div class="flow-column-body">
            ${columnTasks.length ? columnTasks.map(compactTaskCard).join('') : '<div class="planning-empty compact">업무 없음</div>'}
          </div>
        </section>
      `;
    }).join('');
  };

  const renderDependencyFlow = () => {
    const container = $('dependencyFlow');
    if (!container) return;
    const items = window.PlanningStore.sort(visibleTasks());
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const blocked = items.filter((task) => task.dependsOnTaskIds.some((id) => byId.get(id)?.status !== 'done')).slice(0, 5);
    const ready = items.filter((task) => task.status !== 'done' && !task.dependsOnTaskIds.some((id) => byId.get(id)?.status !== 'done')).slice(0, 5);
    const next = items.filter((task) => task.status !== 'done' && task.relatedTaskIds.length).slice(0, 5);
    const groups = [
      ['선행 업무', blocked],
      ['지금 해야 할 업무', ready],
      ['다음 업무', next],
    ];

    container.innerHTML = groups.map(([label, list]) => `
      <section class="relationship-column">
        <div class="relationship-title">${label}</div>
        <div class="relationship-list">
          ${list.length ? list.map((task) => `
            <div class="relationship-item">
              <strong>${escapeHtml(task.title)}</strong>
              <span>${escapeHtml(task.project)} · ${task.dueDate ? escapeHtml(task.dueDate) : '기한 없음'}</span>
            </div>
          `).join('') : '<div class="planning-empty compact">표시할 업무 없음</div>'}
        </div>
      </section>
    `).join('');
  };

  const mermaidSafeLabel = (value) => String(value || '')
    .replace(/[<>{}[\]|"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);

  const loadMermaid = () => {
    if (!mermaidPromise) {
      mermaidPromise = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
        .then((module) => {
          const mermaid = module.default;
          mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'strict',
            flowchart: { curve: 'basis', nodeSpacing: 34, rankSpacing: 42 },
            themeVariables: {
              darkMode: true,
              primaryColor: '#111827',
              primaryTextColor: '#e5e7eb',
              primaryBorderColor: '#22d3ee',
              lineColor: '#64748b',
              fontFamily: 'Noto Sans KR, sans-serif',
            },
          });
          return mermaid;
        });
    }
    return mermaidPromise;
  };

  const flowNodeClass = (task, focus) => {
    if (focus && task.id === focus.id) return 'focus';
    if (task.status === 'done') return 'done';
    if (taskTone(task) === 'overdue') return 'overdue';
    if (task.priority === 'urgent' || task.priority === 'high') return 'urgent';
    if (task.status === 'doing' || task.status === 'review') return 'doing';
    return 'normal';
  };

  const buildFlowGraph = (items) => {
    const active = window.PlanningStore.sort(items.filter((task) => task.status !== 'done')).slice(0, 18);
    const focus = topFocusTask(items);
    const idToTask = new Map(tasks.map((task) => [task.id, task]));
    const graphTasks = new Map();
    const edges = [];

    active.forEach((task) => {
      task.dependsOnTaskIds.forEach((dependencyId) => {
        const dependency = idToTask.get(dependencyId);
        if (!dependency || !workAreaMatches(dependency)) return;
        graphTasks.set(dependency.id, dependency);
        graphTasks.set(task.id, task);
        edges.push([dependency.id, task.id]);
      });
    });

    if (!edges.length) {
      const projectGroups = new Map();
      active.forEach((task) => {
        const key = task.project || '일반 업무';
        if (!projectGroups.has(key)) projectGroups.set(key, []);
        projectGroups.get(key).push(task);
      });
      const group = [...projectGroups.values()].sort((a, b) => b.length - a.length)[0] || [];
      group.slice(0, 10).forEach((task, index, list) => {
        graphTasks.set(task.id, task);
        if (index > 0) edges.push([list[index - 1].id, task.id]);
      });
    }

    if (focus) graphTasks.set(focus.id, focus);
    const limitedTasks = [...graphTasks.values()].slice(0, 12);
    const limitedIds = new Set(limitedTasks.map((task) => task.id));
    const nodeIds = new Map(limitedTasks.map((task, index) => [task.id, 'n' + index]));
    const visibleEdges = edges.filter(([from, to]) => limitedIds.has(from) && limitedIds.has(to)).slice(0, 14);

    if (!limitedTasks.length) return '';

    const lines = [
      'flowchart LR',
      'classDef normal fill:#111827,stroke:#22d3ee,color:#e5e7eb',
      'classDef focus fill:#164e63,stroke:#fbbf24,color:#ffffff,stroke-width:2px',
      'classDef overdue fill:#3f1d24,stroke:#f87171,color:#fecaca,stroke-width:2px',
      'classDef urgent fill:#312e81,stroke:#a5b4fc,color:#e0e7ff',
      'classDef doing fill:#172554,stroke:#60a5fa,color:#dbeafe',
      'classDef done fill:#052e16,stroke:#4ade80,color:#bbf7d0',
    ];

    limitedTasks.forEach((task) => {
      const id = nodeIds.get(task.id);
      const label = mermaidSafeLabel(task.title) + '<br/>' + (statusLabel[task.status] || task.status);
      lines.push(`${id}["${label}"]`);
      lines.push(`class ${id} ${flowNodeClass(task, focus)}`);
    });

    visibleEdges.forEach(([from, to]) => lines.push(`${nodeIds.get(from)} --> ${nodeIds.get(to)}`));
    if (!visibleEdges.length && limitedTasks.length > 1) {
      limitedTasks.slice(1).forEach((task, index) => lines.push(`${nodeIds.get(limitedTasks[index].id)} --> ${nodeIds.get(task.id)}`));
    }

    return lines.join('\n');
  };

  const renderFlowCanvas = () => {
    const container = $('flowCanvas');
    if (!container) return;
    const graph = buildFlowGraph(visibleTasks());
    if (!graph) {
      container.innerHTML = '<div class="planning-empty compact">표시할 실행 흐름이 없습니다.</div>';
      return;
    }

    const seq = ++mermaidRenderSeq;
    const pre = document.createElement('pre');
    pre.className = 'mermaid';
    pre.textContent = graph;
    container.innerHTML = '';
    container.appendChild(pre);

    window.requestIdleCallback ? window.requestIdleCallback(() => {
      loadMermaid()
        .then((mermaid) => seq === mermaidRenderSeq && mermaid.run({ nodes: [pre], suppressErrors: true }))
        .catch(() => { if (seq === mermaidRenderSeq) container.innerHTML = '<div class="planning-empty compact">Flow Canvas를 불러오지 못했습니다.</div>'; });
    }) : window.setTimeout(() => {
      loadMermaid()
        .then((mermaid) => seq === mermaidRenderSeq && mermaid.run({ nodes: [pre], suppressErrors: true }))
        .catch(() => { if (seq === mermaidRenderSeq) container.innerHTML = '<div class="planning-empty compact">Flow Canvas를 불러오지 못했습니다.</div>'; });
    }, 0);
  };

  const loadNotionPreview = async () => {
    const statusNode = $('notionPreviewStatus');
    const button = $('loadNotionPreviewBtn');
    if (!window.PlanningNotionPreview || !statusNode || !button) return;

    statusNode.innerHTML = '<span class="loading-spinner small"></span> Notion 미리보기를 준비 중입니다.';
    button.disabled = true;
    try {
      exportAnalysis = null;
      notionPreviewTasks = await window.PlanningNotionPreview.load();
      selectedPreviewIds = new Set();
      renderExportSummary();
      renderNotionPreview();
    } catch (error) {
      console.warn('Notion preview load failed', error);
      statusNode.textContent = 'Notion 미리보기를 불러오지 못했습니다. 연결 상태를 확인해 주세요.';
    } finally {
      button.disabled = false;
    }
  };

  const parseBriefingSections = (text) => {
    const sectionNames = ['오늘 가장 중요한 업무', '병목 업무', '지연 위험', '추천 행동'];
    const sections = {};
    let current = '';
    String(text || '').split('\n').forEach((rawLine) => {
      const line = rawLine.trim().replace(/^#+\s*/, '').replace(/\*\*/g, '');
      const matched = sectionNames.find((name) => line.includes(name));
      if (matched) {
        current = matched;
        if (!sections[current]) sections[current] = [];
        const remainder = line.replace(matched, '').replace(/^[:：\-\s]+/, '').trim();
        if (remainder) sections[current].push(remainder);
        return;
      }
      if (!current || !line) return;
      sections[current].push(line.replace(/^[-•*]\s*/, ''));
    });
    return sections;
  };

  const renderBriefingText = (text) => {
    const output = $('aiBriefingOutput');
    if (!output) return;
    output.className = 'ai-briefing-output';
    const sections = parseBriefingSections(text);
    const sectionNames = ['오늘 가장 중요한 업무', '병목 업무', '지연 위험', '추천 행동'];
    const hasStructuredContent = sectionNames.some((name) => sections[name]?.length);
    if (!hasStructuredContent) {
      lastBriefingSections = null;
      output.textContent = text;
      renderMissionControl();
      return;
    }

    lastBriefingSections = sections;
    output.innerHTML = '<div class="ai-briefing-grid">' + sectionNames.map((name) => {
      const tone = name.includes('위험') || name.includes('병목') ? 'risk' : name.includes('추천') ? 'action' : '';
      const items = (sections[name] || ['확인 필요']).slice(0, 4);
      return `
        <article class="ai-briefing-card ${tone}">
          <div class="ai-briefing-card-title">${escapeHtml(name)}</div>
          <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </article>
      `;
    }).join('') + '</div>';
    renderMissionControl();
  };

  const generateAiBriefing = async () => {
    const output = $('aiBriefingOutput');
    const button = $('generateBriefingBtn');
    if (!window.PlanningBriefing || !output || !button) return;

    const briefingTasks = visibleTasks();
    if (!briefingTasks.length) {
      renderBriefingText('현재 선택한 조건에 해당하는 업무가 없습니다. 업무영역이나 필터를 확인해 주세요.');
      return;
    }

    output.className = 'ai-briefing-output loading';
    output.innerHTML = '<span class="loading-spinner small"></span> AI 운영 브리핑을 생성 중입니다.';
    button.disabled = true;
    try {
      const briefing = await window.PlanningBriefing.createBriefing(briefingTasks);
      renderBriefingText(briefing);
    } catch (error) {
      console.warn('AI briefing failed', error);
      output.className = 'ai-briefing-output error';
      output.textContent = error.message || 'AI 브리핑을 생성하지 못했습니다.';
    } finally {
      button.disabled = false;
    }
  };

  const analyzeExportZip = async () => {
    const statusNode = $('notionPreviewStatus');
    const button = $('analyzeExportZipBtn');
    const file = selectedZipFile();
    if (!window.PlanningExportImport || !statusNode || !button) return;
    if (!file) {
      toast('가져올 Notion Export ZIP 파일을 선택해 주세요.');
      return;
    }

    statusNode.innerHTML = '<span class="loading-spinner small"></span> Notion Export ZIP을 분석 중입니다.';
    button.disabled = true;
    try {
      exportAnalysis = await window.PlanningExportImport.analyze(file);
      notionPreviewTasks = exportAnalysis.tasks;
      selectedPreviewIds = new Set(notionPreviewTasks.map((task) => task.id));
      renderExportSummary();
      renderNotionPreview();
      toast('ERP 가져오기 후보 ' + notionPreviewTasks.length + '건을 찾았습니다.');
    } catch (error) {
      console.warn('Notion export analyze failed', error);
      exportAnalysis = null;
      notionPreviewTasks = [];
      selectedPreviewIds = new Set();
      renderExportSummary();
      renderNotionPreview();
      statusNode.textContent = error.message || 'Notion Export ZIP을 분석하지 못했습니다.';
    } finally {
      button.disabled = false;
    }
  };

  const importSelectedNotionTasks = () => {
    if (!notionPreviewTasks.length) {
      toast('먼저 Notion Export ZIP을 분석해 주세요.');
      return;
    }

    const importedIds = importedNotionIds();
    const selectedTasks = notionPreviewTasks.filter((task) => selectedPreviewIds.has(task.id) && workAreaMatches(task));
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
        source: task.source === 'notion-export-preview' ? 'notion-export-import' : 'notion-import',
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
    updateProjectFilter();
    renderMissionControl();
    renderStats();
    renderSummary();
    renderFlowCanvas();
    renderFlowBoard();
    renderDependencyFlow();
    renderList();
  };

  const resetForm = () => {
    $('taskForm').reset();
    $('taskId').value = '';
    $('taskWorkArea').value = activeWorkArea === '전체' ? '경영지원' : activeWorkArea;
    $('taskPriority').value = 'normal';
    $('taskStatus').value = 'todo';
    $('formTitle').textContent = '업무 추가';
  };

  const formValue = () => ({
    title: $('taskTitle').value,
    workArea: $('taskWorkArea').value,
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
    $('taskWorkArea').value = task.workArea || '경영지원';
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
    $('projectFilter').addEventListener('change', renderAll);
    $('statusFilter').addEventListener('change', renderAll);
    $('priorityFilter').addEventListener('change', renderAll);
    $('generateBriefingBtn').addEventListener('click', generateAiBriefing);
    $('loadNotionPreviewBtn').addEventListener('click', loadNotionPreview);
    $('analyzeExportZipBtn').addEventListener('click', analyzeExportZip);
    $('notionExportZipInput').addEventListener('change', () => {
      updateExportFileLabel();
      exportAnalysis = null;
      notionPreviewTasks = [];
      selectedPreviewIds = new Set();
      renderExportSummary();
      renderNotionPreview();
    });
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

    $('workAreaTabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.workarea-tab');
      if (!tab) return;
      activeWorkArea = tab.dataset.workArea;
      document.querySelectorAll('.workarea-tab').forEach((node) => node.classList.remove('active'));
      tab.classList.add('active');
      selectedPreviewIds = new Set();
      resetForm();
      renderAll();
      renderNotionPreview();
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
    updateExportFileLabel();
    renderExportSummary();
    renderAll();
    renderNotionPreview();
    addAiMessage('bot', '로컬 업무 데이터만 기준으로 답변합니다. 예: 오늘 무엇에 집중할까?');
    $('summaryModal').classList.add('open');

    if (reminderStop) reminderStop();
    reminderStop = window.PlanningReminders.start(() => tasks, (message) => toast(message));
  };

  window.PlanningUI = { init };
})();
