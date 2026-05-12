(function () {
  const notified = new Set();

  const minutesUntil = (task) => {
    if (!task.dueDate || !task.dueTime) return null;
    const due = new Date(task.dueDate + 'T' + task.dueTime);
    if (Number.isNaN(due.getTime())) return null;
    return Math.round((due.getTime() - Date.now()) / 60000);
  };

  const messageFor = (task) => {
    const mins = minutesUntil(task);
    if (mins === null) return null;
    if (mins < 0) return task.title + ' is overdue.';
    if (mins <= 60) return task.title + ' is due in ' + mins + ' minute(s).';
    return null;
  };

  const check = (tasks, notify) => {
    tasks.filter((task) => task.status !== 'done').forEach((task) => {
      const message = messageFor(task);
      const key = task.id + ':' + task.dueDate + ':' + task.dueTime + ':' + message;
      if (!message || notified.has(key)) return;
      notified.add(key);
      notify(message, task);
    });
  };

  const start = (getTasks, notify) => {
    const run = () => check(getTasks(), notify);
    run();
    const timer = window.setInterval(run, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) run();
    });
    return () => window.clearInterval(timer);
  };

  window.PlanningReminders = { start, check };
})();
