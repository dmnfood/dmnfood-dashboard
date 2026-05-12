(function () {
  const STORAGE_KEY = 'dmn_planning_tasks_v1';
  const uid = () => 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  const asDateKey = (value) => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  };

  const todayKey = () => asDateKey(new Date());
  const daysBetween = (a, b) => {
    const left = new Date(asDateKey(a) + 'T00:00:00');
    const right = new Date(asDateKey(b) + 'T00:00:00');
    return Math.round((left - right) / 86400000);
  };

  const normalizeTask = (task) => ({
    id: task.id || uid(),
    title: String(task.title || '').trim(),
    notes: String(task.notes || '').trim(),
    owner: String(task.owner || '').trim(),
    dueDate: asDateKey(task.dueDate),
    dueTime: String(task.dueTime || '').trim(),
    priority: ['low', 'normal', 'high', 'urgent'].includes(task.priority) ? task.priority : 'normal',
    status: ['todo', 'doing', 'done'].includes(task.status) ? task.status : 'todo',
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const seedTasks = () => {
    const today = todayKey();
    const tomorrow = new Date(today + 'T00:00:00');
    tomorrow.setDate(tomorrow.getDate() + 1);
    return [
      normalizeTask({
        title: 'Check purchase schedule',
        notes: 'Review near-term ingredients and vendor timing.',
        owner: 'Planning',
        dueDate: today,
        dueTime: '10:00',
        priority: 'high',
        status: 'todo',
      }),
      normalizeTask({
        title: 'Prepare weekly production notes',
        notes: 'Capture blockers and required follow-ups before the next review.',
        owner: 'Planning',
        dueDate: asDateKey(tomorrow),
        dueTime: '15:00',
        priority: 'normal',
        status: 'doing',
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
    const dateA = a.dueDate || '9999-12-31';
    const dateB = b.dueDate || '9999-12-31';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
    return rank[a.priority] - rank[b.priority] || a.title.localeCompare(b.title);
  });

  const PlanningStore = {
    init() {
      const tasks = load();
      if (!tasks.length && !localStorage.getItem(STORAGE_KEY)) {
        const seeded = seedTasks();
        save(seeded);
        return seeded;
      }
      return tasks;
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
    todayKey,
    daysBetween,
  };

  window.PlanningStore = PlanningStore;
})();
