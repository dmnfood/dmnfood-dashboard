(function () {
  const STORAGE_KEY = 'dmn_planning_tasks_v1';
  const uid = () => 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const asDateKey = (value) => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  };

  const addDays = (dateKey, days) => {
    const date = new Date(asDateKey(dateKey) + 'T00:00:00');
    date.setDate(date.getDate() + days);
    return asDateKey(date);
  };

  const todayKey = () => asDateKey(new Date());
  const daysBetween = (a, b) => {
    const left = new Date(asDateKey(a) + 'T00:00:00');
    const right = new Date(asDateKey(b) + 'T00:00:00');
    return Math.round((left - right) / 86400000);
  };

  const toIdList = (value) => Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

  const normalizeTask = (task) => {
    const createdAt = task.createdAt || new Date().toISOString();
    const dueDate = asDateKey(task.dueDate);
    const startDate = asDateKey(task.startDate) || dueDate;

    return {
      id: task.id || uid(),
      title: String(task.title || '').trim(),
      notes: String(task.notes || '').trim(),
      owner: String(task.owner || '').trim(),
      project: String(task.project || task.businessArea || '일반 업무').trim(),
      phase: String(task.phase || '실행').trim(),
      startDate,
      dueDate,
      dueTime: String(task.dueTime || '').trim(),
      priority: ['low', 'normal', 'high', 'urgent'].includes(task.priority) ? task.priority : 'normal',
      status: ['todo', 'doing', 'done'].includes(task.status) ? task.status : 'todo',
      dependsOnTaskIds: toIdList(task.dependsOnTaskIds),
      relatedTaskIds: toIdList(task.relatedTaskIds),
      notionPageId: String(task.notionPageId || '').trim(),
      notionUrl: String(task.notionUrl || '').trim(),
      relationRefs: task.relationRefs && typeof task.relationRefs === 'object' ? task.relationRefs : null,
      source: String(task.source || 'local').trim(),
      importedAt: task.importedAt || '',
      createdAt,
      updatedAt: new Date().toISOString(),
    };
  };

  const seedTasks = () => {
    const today = todayKey();
    return [
      normalizeTask({
        id: 'seed-bom',
        title: '기초 등록 - BOM 등록',
        notes: '주요 제품별 원재료 구성과 단위 소요량을 기준 데이터로 정리합니다.',
        owner: '생산관리',
        project: '생산 관리 시스템 구축',
        phase: '기초 등록',
        startDate: addDays(today, -4),
        dueDate: addDays(today, 1),
        dueTime: '10:00',
        priority: 'high',
        status: 'doing',
      }),
      normalizeTask({
        id: 'seed-vendor',
        title: '거래처 등록',
        notes: '신규 납품처 사업자 정보, 담당자, 정산 조건을 확인합니다.',
        owner: '영업관리',
        project: '거래처 운영 정비',
        phase: '등록',
        startDate: addDays(today, -2),
        dueDate: today,
        dueTime: '14:00',
        priority: 'urgent',
        status: 'todo',
        relatedTaskIds: ['seed-ar'],
      }),
      normalizeTask({
        id: 'seed-haccp',
        title: 'HACCP 점검 일정',
        notes: '월간 위생 점검표와 현장 개선 항목을 생산 일정과 함께 조율합니다.',
        owner: '품질관리',
        project: '품질 점검',
        phase: '점검',
        startDate: addDays(today, 1),
        dueDate: addDays(today, 5),
        priority: 'high',
        status: 'todo',
        dependsOnTaskIds: ['seed-bom'],
      }),
      normalizeTask({
        id: 'seed-profit',
        title: '월별 손익 자동화',
        notes: '매출, 원가, 고정비 자료를 월별 손익표 기준으로 연결합니다.',
        owner: '경영지원',
        project: '자금/손익 관리',
        phase: '자동화',
        startDate: addDays(today, -1),
        dueDate: addDays(today, 8),
        priority: 'normal',
        status: 'doing',
        dependsOnTaskIds: ['seed-bom'],
        relatedTaskIds: ['seed-ar'],
      }),
      normalizeTask({
        id: 'seed-ar',
        title: '미수금 확인',
        notes: '주요 거래처 미수금과 회수 예정일을 확인하고 우선순위를 정리합니다.',
        owner: '경리',
        project: '자금/손익 관리',
        phase: '확인',
        startDate: addDays(today, -3),
        dueDate: addDays(today, -1),
        priority: 'high',
        status: 'todo',
      }),
      normalizeTask({
        id: 'seed-export',
        title: '수출 서류 점검',
        notes: '출고 예정 건의 인보이스, 패킹리스트, 원산지 서류 상태를 확인합니다.',
        owner: '해외영업',
        project: '수출 출고 관리',
        phase: '서류',
        startDate: addDays(today, 2),
        dueDate: addDays(today, 10),
        priority: 'normal',
        status: 'todo',
        dependsOnTaskIds: ['seed-vendor'],
      }),
      normalizeTask({
        id: 'seed-shipping',
        title: '거래처 출고 확인',
        notes: '오전 발주 내역을 확인하고 출고 가능 수량과 납기 변동 사항을 공유합니다.',
        owner: '물류',
        project: '거래처 운영 정비',
        phase: '출고',
        startDate: today,
        dueDate: addDays(today, 3),
        priority: 'normal',
        status: 'todo',
        dependsOnTaskIds: ['seed-vendor'],
      }),
    ];
  };

  const load = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.map(normalizeTask).filter((task) => task.title) : [];
    } catch (error) {
      console.warn('PlanningStore load failed', error);
      return [];
    }
  };

  const save = (tasks) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.map(normalizeTask)));
  };

  const active = (task) => task.status !== 'done';

  const computeBuckets = (tasks) => {
    const today = todayKey();
    const activeTasks = tasks.filter(active);
    const overdue = activeTasks.filter((task) => task.dueDate && daysBetween(task.dueDate, today) < 0);
    const todayTasks = activeTasks.filter((task) => task.dueDate === today);
    const upcoming = activeTasks.filter((task) => {
      if (!task.dueDate) return false;
      const diff = daysBetween(task.dueDate, today);
      return diff > 0 && diff <= 7;
    });
    const urgent = activeTasks.filter((task) => task.priority === 'urgent' || task.priority === 'high' || overdue.includes(task));

    return {
      overdue,
      today: todayTasks,
      upcoming,
      urgent,
      done: tasks.filter((task) => task.status === 'done'),
      active: activeTasks,
    };
  };

  const sortTasks = (tasks) => [...tasks].sort((a, b) => {
    const dateA = a.startDate || a.dueDate || '9999-12-31';
    const dateB = b.startDate || b.dueDate || '9999-12-31';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
    return rank[a.priority] - rank[b.priority] || a.title.localeCompare(b.title);
  });

  const timelineDates = (tasks) => {
    const dated = tasks.flatMap((task) => [task.startDate, task.dueDate]).filter(Boolean).sort();
    const today = todayKey();
    const start = addDays(dated[0] || today, -2);
    const end = addDays(dated[dated.length - 1] || today, 4);
    const days = [];
    for (let current = start; current <= end; current = addDays(current, 1)) days.push(current);
    return days;
  };

  const groupByProject = (tasks) => {
    const groups = new Map();
    sortTasks(tasks).forEach((task) => {
      const key = task.project || '일반 업무';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    });
    return [...groups.entries()].map(([project, items]) => ({ project, items }));
  };

  const PlanningStore = {
    init() {
      const tasks = load();
      if (!tasks.length && !localStorage.getItem(STORAGE_KEY)) {
        const seeded = seedTasks();
        save(seeded);
        return seeded;
      }
      const normalized = tasks.map(normalizeTask);
      save(normalized);
      return normalized;
    },
    all() {
      return load();
    },
    replace(tasks) {
      save(tasks);
      return load();
    },
    add(task) {
      const tasks = load();
      tasks.push(normalizeTask(task));
      save(tasks);
      return tasks;
    },
    update(id, patch) {
      const tasks = load().map((task) => task.id === id ? normalizeTask({ ...task, ...patch, id: task.id, createdAt: task.createdAt }) : task);
      save(tasks);
      return tasks;
    },
    remove(id) {
      const tasks = load().filter((task) => task.id !== id);
      save(tasks);
      return tasks;
    },
    buckets(tasks = load()) {
      return computeBuckets(tasks);
    },
    sort: sortTasks,
    timelineDates,
    groupByProject,
    normalizePreview(task) {
      return normalizeTask({ ...task, source: task.source || 'notion-preview' });
    },
    todayKey,
    addDays,
    daysBetween,
  };

  window.PlanningStore = PlanningStore;
})();
