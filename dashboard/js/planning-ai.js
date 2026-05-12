(function () {
  const answer = (question, tasks) => {
    const q = question.toLowerCase();
    const buckets = window.PlanningStore.buckets(tasks);
    const sorted = window.PlanningStore.sort(buckets.active);

    if (!question.trim()) return 'Ask about today, overdue work, urgent items, or what to do next.';
    if (q.includes('overdue') || q.includes('late')) {
      if (!buckets.overdue.length) return 'No overdue tasks. Keep today focused and avoid adding new work unless it protects a deadline.';
      return 'Overdue first: ' + buckets.overdue.slice(0, 3).map((task) => task.title).join(', ') + '.';
    }
    if (q.includes('today')) {
      if (!buckets.today.length) return 'No tasks are due today. Use the gap to clear one upcoming or high-priority item.';
      return 'Today has ' + buckets.today.length + ' task(s): ' + buckets.today.slice(0, 4).map((task) => task.title).join(', ') + '.';
    }
    if (q.includes('urgent') || q.includes('priority')) {
      if (!buckets.urgent.length) return 'No urgent tasks are marked. The next best focus is the earliest due active task.';
      return 'Urgent queue: ' + buckets.urgent.slice(0, 4).map((task) => task.title).join(', ') + '.';
    }
    if (q.includes('next') || q.includes('focus') || q.includes('recommend')) {
      const task = buckets.overdue[0] || buckets.urgent[0] || buckets.today[0] || sorted[0];
      return task ? 'Next focus: ' + task.title + '. Keep the scope tight and move it to done before starting another item.' : 'Nothing active yet. Add one concrete task with a due date.';
    }
    if (q.includes('summary') || q.includes('status')) {
      return 'Summary: ' + buckets.active.length + ' active, ' + buckets.overdue.length + ' overdue, ' + buckets.today.length + ' due today, ' + buckets.upcoming.length + ' upcoming.';
    }
    return 'Local answer: focus on overdue items first, then urgent, then today, then upcoming. Current active task count is ' + buckets.active.length + '.';
  };

  window.PlanningAI = { answer };
})();
