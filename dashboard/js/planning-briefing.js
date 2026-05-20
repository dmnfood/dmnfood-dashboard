(function () {
  const statusLabel = {
    todo: '시작 전',
    doing: '진행 중',
    review: '확인 필요',
    done: '완료',
  };

  const priorityLabel = {
    low: '낮음',
    normal: '보통',
    high: '높음',
    urgent: '긴급',
  };

  const summarizeTasks = (tasks) => {
    const buckets = window.PlanningStore.buckets(tasks);
    const sorted = window.PlanningStore.sort(tasks).slice(0, 80);
    const completed = tasks
      .filter((task) => task.status === 'done')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 8);

    return {
      generatedAt: new Date().toISOString(),
      counts: {
        total: tasks.length,
        active: buckets.active.length,
        overdue: buckets.overdue.length,
        today: buckets.today.length,
        upcoming: buckets.upcoming.length,
        urgent: buckets.urgent.length,
        completed: buckets.done.length,
      },
      tasks: sorted.map((task) => ({
        title: task.title,
        workArea: task.workArea,
        project: task.project,
        phase: task.phase,
        status: statusLabel[task.status] || task.status,
        priority: priorityLabel[task.priority] || task.priority,
        startDate: task.startDate,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        dependsOnCount: task.dependsOnTaskIds.length,
        relatedCount: task.relatedTaskIds.length,
        source: task.source,
      })),
      recentCompletions: completed.map((task) => ({
        title: task.title,
        project: task.project,
        workArea: task.workArea,
        updatedAt: task.updatedAt,
      })),
    };
  };

  const createBriefing = async (tasks) => {
    const payload = summarizeTasks(tasks);
    const response = await fetch('/api/briefing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ briefingPayload: payload }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'AI 브리핑 요청에 실패했습니다.');
    }

    return String(data.briefing || '').trim() || '브리핑 결과가 비어 있습니다.';
  };

  window.PlanningBriefing = {
    createBriefing,
    summarizeTasks,
  };
})();
