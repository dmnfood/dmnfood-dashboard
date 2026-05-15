(function () {
  const PROJECT_BY_URL = {
    'https://www.notion.so/255aa09abf718173b10cdece4321eae5': '기초 데이터 등록',
    'https://www.notion.so/258aa09abf718081a77efe93921169fa': '원가관리 체계',
    'https://www.notion.so/258aa09abf7180f4a45bdcbc30ae2be8': '손익분석 체계',
    'https://www.notion.so/256aa09abf7180da81bedcffc7255a30': '생산관리 체계',
  };

  const notionTasks = [
    {
      pageId: '255aa09a-bf71-8029-9700-ff5b6a925c78',
      url: 'https://www.notion.so/255aa09abf7180299700ff5b6a925c78',
      title: '기초 등록 - BOM 등록',
      status: '시작 전',
      priority: '중간',
      tags: ['ERP'],
      startDate: '2025-11-24',
      dueDate: '2025-11-28',
      projectUrls: ['https://www.notion.so/255aa09abf718173b10cdece4321eae5'],
      dependsOnUrls: ['https://www.notion.so/256aa09abf7180bea0ffd8604593aa9d'],
      relatedUrls: [
        'https://www.notion.so/256aa09abf7180b9ad69f5ff45bec255',
        'https://www.notion.so/258aa09abf7180e7abe4c09ff9f8fab7',
      ],
      notes: '완제품/반제품별 자재 소요량과 생산 공정 연결 기준을 표준화합니다.',
    },
    {
      pageId: '255aa09a-bf71-81d7-8d5b-daea956e959e',
      url: 'https://www.notion.so/255aa09abf7181d78d5bdaea956e959e',
      title: '기초 잔액 등록',
      status: '진행 중',
      priority: '중간',
      tags: ['ERP'],
      startDate: '2025-10-21',
      dueDate: '2025-11-06',
      projectUrls: ['https://www.notion.so/255aa09abf718173b10cdece4321eae5'],
      dependsOnUrls: [],
      relatedUrls: [],
      notes: '기초 재고 수량, 금액, 매출채권, 매입채무, 예금잔액을 등록합니다.',
    },
    {
      pageId: '255aa09a-bf71-81e6-861a-d095dbf4df3e',
      url: 'https://www.notion.so/255aa09abf7181e6861ad095dbf4df3e',
      title: '기초 등록 - 거래처 등록',
      status: '진행 중',
      priority: '중간',
      tags: ['ERP'],
      startDate: '2025-09-03',
      dueDate: '2025-09-04',
      projectUrls: ['https://www.notion.so/255aa09abf718173b10cdece4321eae5'],
      dependsOnUrls: [],
      relatedUrls: [],
      notes: '매입처와 매출처의 사업자 정보, 담당자, 결제 조건, 세금계산서 이메일을 정리합니다.',
    },
    {
      pageId: '255aa09a-bf71-8102-82b8-ca9daf0f5084',
      url: 'https://www.notion.so/255aa09abf71810282b8ca9daf0f5084',
      title: '기초 등록 - 품목 등록',
      status: '테스트 중',
      priority: '중간',
      tags: ['ERP'],
      startDate: '2025-09-01',
      dueDate: '2025-09-02',
      projectUrls: ['https://www.notion.so/255aa09abf718173b10cdece4321eae5'],
      dependsOnUrls: [],
      relatedUrls: ['https://www.notion.so/256aa09abf7180bea0ffd8604593aa9d'],
      notes: '완제품, 반제품, 원자재, 부자재의 코드와 단위, 규격, 관리 기준을 통일합니다.',
    },
    {
      pageId: '258aa09a-bf71-80e7-abe4-c09ff9f8fab7',
      url: 'https://www.notion.so/258aa09abf7180e7abe4c09ff9f8fab7',
      title: '표준원가 계산',
      status: '시작 전',
      priority: '중간',
      tags: ['ERP'],
      startDate: '2025-12-01',
      dueDate: '2025-12-05',
      projectUrls: ['https://www.notion.so/258aa09abf718081a77efe93921169fa'],
      dependsOnUrls: ['https://www.notion.so/255aa09abf7180299700ff5b6a925c78'],
      relatedUrls: [
        'https://www.notion.so/258aa09abf7180d9a03ad6e853bec042',
        'https://www.notion.so/258aa09abf71801ca340cb18fe6bec24',
      ],
      notes: '제품별 원재료비, 노무비, 제조간접비를 기준 단위당 원가로 산정합니다.',
    },
    {
      pageId: '258aa09a-bf71-801c-a340-cb18fe6bec24',
      url: 'https://www.notion.so/258aa09abf71801ca340cb18fe6bec24',
      title: '표준원가와 실제원가 관리',
      status: '시작 전',
      priority: '중간',
      tags: ['ERP'],
      startDate: '2025-12-08',
      dueDate: '2025-12-12',
      projectUrls: ['https://www.notion.so/258aa09abf718081a77efe93921169fa'],
      dependsOnUrls: ['https://www.notion.so/258aa09abf7180e7abe4c09ff9f8fab7'],
      relatedUrls: ['https://www.notion.so/258aa09abf71800f9918d66237754243'],
      notes: '실제 발생 원가를 ERP에 기록하고 표준원가와 비교해 차이 원인을 검토합니다.',
    },
    {
      pageId: '258aa09a-bf71-80a1-9259-cc48edcf342b',
      url: 'https://www.notion.so/258aa09abf7180a19259cc48edcf342b',
      title: '채널·거래처별 손익분석 리포트',
      status: '시작 전',
      priority: '중간',
      tags: [],
      startDate: '2025-11-24',
      dueDate: '2025-12-05',
      projectUrls: ['https://www.notion.so/258aa09abf7180f4a45bdcbc30ae2be8'],
      dependsOnUrls: [],
      relatedUrls: ['https://www.notion.so/258aa09abf7180698e57f3f1d07a102f'],
      notes: '유통사, 직영몰, 온라인몰 수익률을 비교하고 거래처 조건을 반영합니다.',
    },
    {
      pageId: '258aa09a-bf71-8069-8e57-f3f1d07a102f',
      url: 'https://www.notion.so/258aa09abf7180698e57f3f1d07a102f',
      title: '월별 손익 보고 자동화',
      status: '시작 전',
      priority: '',
      tags: [],
      startDate: '2025-12-08',
      dueDate: '2025-12-21',
      projectUrls: ['https://www.notion.so/258aa09abf7180f4a45bdcbc30ae2be8'],
      dependsOnUrls: ['https://www.notion.so/258aa09abf7180a19259cc48edcf342b'],
      relatedUrls: [],
      notes: 'ERP 매출·원가 데이터를 Power Query로 연결해 손익 리포트를 자동 업데이트합니다.',
    },
    {
      pageId: '256aa09a-bf71-80b9-ad69-f5ff45bec255',
      url: 'https://www.notion.so/256aa09abf7180b9ad69f5ff45bec255',
      title: '생산 관리 시스템 구축 및 학습',
      status: '시작 전',
      priority: '높음',
      tags: ['생산'],
      startDate: '2025-12-01',
      dueDate: '2025-12-12',
      projectUrls: ['https://www.notion.so/256aa09abf7180da81bedcffc7255a30'],
      dependsOnUrls: ['https://www.notion.so/255aa09abf7180299700ff5b6a925c78'],
      relatedUrls: ['https://www.notion.so/256aa09abf7180aa8c0be24fba85614f'],
      notes: 'ERP 프로세스, 현장 기록 방식, 필요한 기기와 교육 범위를 함께 검토합니다.',
    },
  ];

  const statusMap = {
    '시작 전': 'todo',
    '진행 중': 'doing',
    '테스트 중': 'doing',
    '완료': 'done',
    '보관': 'done',
  };

  const priorityMap = {
    '낮음': 'low',
    '중간': 'normal',
    '높음': 'high',
  };

  const pageIdFromUrl = (url) => String(url || '').split('/').pop() || '';
  const previewId = (value) => 'notion_' + String(value || '').replace(/-/g, '');

  const mapTask = (raw) => {
    const project = raw.projectUrls.map((url) => PROJECT_BY_URL[url]).filter(Boolean).join(', ') || 'Notion 작업';
    return window.PlanningStore.normalizePreview({
      id: previewId(raw.pageId),
      title: raw.title,
      notes: raw.notes,
      owner: 'Notion',
      project,
      phase: raw.tags[0] || 'Notion',
      startDate: raw.startDate,
      dueDate: raw.dueDate,
      priority: priorityMap[raw.priority] || 'normal',
      status: statusMap[raw.status] || 'todo',
      dependsOnTaskIds: raw.dependsOnUrls.map((url) => previewId(pageIdFromUrl(url))),
      relatedTaskIds: raw.relatedUrls.map((url) => previewId(pageIdFromUrl(url))),
      notionPageId: raw.pageId,
      notionUrl: raw.url,
      source: 'notion-preview',
      importedAt: new Date().toISOString(),
      relationRefs: {
        projectUrls: raw.projectUrls,
        dependsOnUrls: raw.dependsOnUrls,
        relatedUrls: raw.relatedUrls,
      },
    });
  };

  const load = () => new Promise((resolve) => {
    window.setTimeout(() => resolve(notionTasks.map(mapTask)), 180);
  });

  window.PlanningNotionPreview = {
    load,
    sourceName: 'Notion 작업 데이터베이스',
  };
})();
