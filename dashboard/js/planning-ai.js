(function () {
  const answer = (question, tasks) => {
    const q = question.toLowerCase();
    const buckets = window.PlanningStore.buckets(tasks);
    const sorted = window.PlanningStore.sort(buckets.active);

    if (!question.trim()) return '오늘 할 일, 지연 업무, 긴급 업무, 다음 집중 업무를 물어보세요.';
    if (q.includes('overdue') || q.includes('late') || q.includes('지연') || q.includes('늦')) {
      if (!buckets.overdue.length) return '지연 업무는 없습니다. 오늘 할 일을 먼저 마무리하고, 기한에 영향이 있을 때만 새 업무를 추가하세요.';
      return '지연 업무부터 확인하세요: ' + buckets.overdue.slice(0, 3).map((task) => task.title).join(', ') + '.';
    }
    if (q.includes('today') || q.includes('오늘')) {
      if (!buckets.today.length) return '오늘 기한인 업무는 없습니다. 여유가 있으면 예정 업무나 높은 우선순위 업무 하나를 먼저 정리하세요.';
      return '오늘 할 일은 ' + buckets.today.length + '건입니다: ' + buckets.today.slice(0, 4).map((task) => task.title).join(', ') + '.';
    }
    if (q.includes('urgent') || q.includes('priority') || q.includes('긴급') || q.includes('우선')) {
      if (!buckets.urgent.length) return '긴급으로 표시된 업무는 없습니다. 다음 집중 대상은 기한이 가장 가까운 진행 업무입니다.';
      return '긴급 업무 목록: ' + buckets.urgent.slice(0, 4).map((task) => task.title).join(', ') + '.';
    }
    if (q.includes('next') || q.includes('focus') || q.includes('recommend') || q.includes('다음') || q.includes('집중') || q.includes('추천')) {
      const task = buckets.overdue[0] || buckets.urgent[0] || buckets.today[0] || sorted[0];
      return task ? '다음 집중 업무: ' + task.title + '. 범위를 작게 잡고 완료 처리한 뒤 다음 업무로 넘어가세요.' : '진행 중인 업무가 없습니다. 기한이 있는 구체적인 업무를 하나 추가하세요.';
    }
    if (q.includes('summary') || q.includes('status') || q.includes('요약') || q.includes('현황')) {
      return '요약: 진행 업무 ' + buckets.active.length + '건, 지연 업무 ' + buckets.overdue.length + '건, 오늘 할 일 ' + buckets.today.length + '건, 예정 업무 ' + buckets.upcoming.length + '건입니다.';
    }
    return '로컬 답변: 지연 업무, 긴급 업무, 오늘 할 일, 예정 업무 순서로 확인하세요. 현재 진행 업무는 ' + buckets.active.length + '건입니다.';
  };

  window.PlanningAI = { answer };
})();
