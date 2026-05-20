(function () {
  const ERP_KEYWORDS = [
    'ERP',
    '생산관리',
    '생산 관리',
    '원가관리',
    '원가 관리',
    '손익분석',
    '손익 분석',
    '기초 등록',
    '기초 데이터',
  ];

  const STATUS_MAP = {
    '시작 전': 'todo',
    '계획 중': 'todo',
    '진행 중': 'doing',
    '테스트 중': 'review',
    '확인 필요': 'review',
    완료: 'done',
    보관: 'done',
    취소: 'done',
  };

  const PRIORITY_MAP = {
    낮음: 'low',
    중간: 'normal',
    보통: 'normal',
    높음: 'high',
    긴급: 'urgent',
  };

  const decoder = new TextDecoder('utf-8');

  const cleanTitle = (value) => String(value || '')
    .replace(/\s*\([^)]*\.md\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const fileBaseName = (path) => {
    const name = String(path || '').split('/').pop() || '';
    return name.replace(/\.[^.]+$/, '').replace(/\s+[0-9a-f]{32}$/i, '').trim();
  };

  const uuidFromText = (value) => {
    const compact = String(value || '').match(/[0-9a-f]{32}/i)?.[0] || '';
    if (!compact) return '';
    return compact.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  };

  const includesErpKeyword = (...values) => {
    const text = values.join(' ');
    return ERP_KEYWORDS.some((keyword) => text.includes(keyword));
  };

  const parseCsv = (text) => {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (quoted) {
        if (char === '"' && next === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          cell += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(cell);
        cell = '';
      } else if (char === '\n') {
        row.push(cell.replace(/\r$/, ''));
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }

    if (cell || row.length) {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
    }

    const headers = rows.shift() || [];
    return rows
      .filter((item) => item.some((value) => String(value || '').trim()))
      .map((item) => headers.reduce((rowObject, header, index) => {
        rowObject[String(header || '').trim()] = String(item[index] || '').trim();
        return rowObject;
      }, {}));
  };

  const parseKoreanDateRange = (value) => {
    const matches = String(value || '').match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/g) || [];
    const dates = matches.map((dateText) => {
      const parts = dateText.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
      if (!parts) return '';
      return [
        parts[1],
        parts[2].padStart(2, '0'),
        parts[3].padStart(2, '0'),
      ].join('-');
    }).filter(Boolean);

    if (!dates.length && /^\d{4}-\d{2}-\d{2}/.test(String(value || ''))) {
      dates.push(String(value).slice(0, 10));
    }

    return {
      startDate: dates[0] || '',
      dueDate: dates[dates.length - 1] || dates[0] || '',
    };
  };

  const extractRelationTitles = (value) => String(value || '')
    .split(/\),\s*/)
    .map((item) => cleanTitle(item))
    .filter(Boolean);

  const markdownText = (value) => String(value || '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const inflateRaw = async (bytes) => {
    if (!window.DecompressionStream) {
      throw new Error('이 브라우저는 ZIP 압축 해제를 지원하지 않습니다.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  const readZipEntries = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let eocdOffset = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 66000); offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error('ZIP 중앙 디렉터리를 찾지 못했습니다.');

    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    const entries = [];
    let pointer = centralOffset;

    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(pointer, true) !== 0x02014b50) break;
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const fileNameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = decoder.decode(bytes.slice(pointer + 46, pointer + 46 + fileNameLength));
      pointer += 46 + fileNameLength + extraLength + commentLength;

      if (name.endsWith('/')) continue;

      const localFileNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localFileNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      const contentBytes = method === 0 ? compressed : await inflateRaw(compressed);
      entries.push({ name, text: decoder.decode(contentBytes) });
    }

    return entries;
  };

  const chooseCsv = (entries, keyword) => {
    const candidates = entries.filter((entry) => entry.name.endsWith('.csv') && fileBaseName(entry.name).startsWith(keyword));
    return candidates.find((entry) => entry.name.includes('_all.csv')) || candidates[0] || null;
  };

  const buildMarkdownIndex = (entries) => {
    const byTitle = new Map();
    const byId = new Map();
    entries.filter((entry) => entry.name.endsWith('.md')).forEach((entry) => {
      const title = fileBaseName(entry.name);
      const id = uuidFromText(entry.name);
      const text = markdownText(entry.text);
      byTitle.set(title, { title, id, text, fileName: entry.name });
      if (id) byId.set(id.replace(/-/g, ''), { title, id, text, fileName: entry.name });
    });
    return { byTitle, byId };
  };

  const buildProjectIndex = (rows, markdownIndex) => {
    const projects = new Map();
    rows.forEach((row) => {
      const title = cleanTitle(row['프로젝트']);
      if (!title) return;
      const period = parseKoreanDateRange(row['기간']);
      const markdown = markdownIndex.byTitle.get(title);
      projects.set(title, {
        title,
        status: row['진행 상태'] || '',
        priority: row['우선순위'] || '',
        summary: row['요약'] || '',
        startDate: period.startDate,
        dueDate: period.dueDate,
        markdown: markdown?.text || '',
      });
    });
    return projects;
  };

  const mapTaskRows = (rows, projectIndex, markdownIndex) => {
    const titleToId = new Map();
    rows.forEach((row) => {
      const title = cleanTitle(row['작업']);
      const markdown = markdownIndex.byTitle.get(title);
      const id = markdown?.id || uuidFromText(row['작업'] || title) || 'export_' + title;
      if (title) titleToId.set(title, 'notion_export_' + id.replace(/[^a-z0-9]/gi, '').toLowerCase());
    });

    return rows.map((row) => {
      const title = cleanTitle(row['작업']);
      if (!title) return null;
      const project = cleanTitle(row['프로젝트']) || 'ERP 운영 계획';
      const phase = (row['태그'] || '').split(',').map((tag) => tag.trim()).filter(Boolean)[0] || project;
      const dateRange = parseKoreanDateRange(row['마감일']);
      const taskMarkdown = markdownIndex.byTitle.get(title);
      const pageId = taskMarkdown?.id || uuidFromText(row['작업']) || uuidFromText(row['프로젝트']) || 'export_' + title;
      const projectInfo = projectIndex.get(project);
      const dependsOnTitles = extractRelationTitles(row['선행 작업']);
      const relatedTitles = [
        ...extractRelationTitles(row['상위 작업']),
        ...extractRelationTitles(row['하위 작업']),
        ...extractRelationTitles(row['후속 작업']),
      ];
      const notes = [
        row['태그'] ? '태그: ' + row['태그'] : '',
        projectInfo?.summary ? '프로젝트 요약: ' + projectInfo.summary : '',
        taskMarkdown?.text ? taskMarkdown.text.slice(0, 1200) : '',
      ].filter(Boolean).join('\n\n');

      return window.PlanningStore.normalizePreview({
        id: titleToId.get(title),
        title,
        workArea: 'ERP',
        project,
        phase,
        owner: String(row['담당자'] || '').replace(/"/g, '').trim(),
        notes,
        startDate: dateRange.startDate,
        dueDate: dateRange.dueDate,
        priority: PRIORITY_MAP[row['우선순위']] || 'normal',
        status: STATUS_MAP[row['진행 상태']] || 'todo',
        dependsOnTaskIds: dependsOnTitles.map((item) => titleToId.get(item)).filter(Boolean),
        relatedTaskIds: relatedTitles.map((item) => titleToId.get(item)).filter(Boolean),
        notionPageId: pageId,
        notionUrl: '',
        source: 'notion-export-preview',
        importedAt: new Date().toISOString(),
        relationRefs: {
          exportFile: taskMarkdown?.fileName || '',
          projectFile: projectInfo?.title || '',
          dependsOnTitles,
          relatedTitles,
        },
      });
    }).filter(Boolean);
  };

  const analyze = async (file) => {
    const entries = await readZipEntries(file);
    const markdownIndex = buildMarkdownIndex(entries);
    const taskCsv = chooseCsv(entries, '작업');
    const projectCsv = chooseCsv(entries, '프로젝트');
    if (!taskCsv) throw new Error('작업.csv를 찾지 못했습니다.');

    const taskRows = parseCsv(taskCsv.text);
    const projectRows = projectCsv ? parseCsv(projectCsv.text) : [];
    const projectIndex = buildProjectIndex(projectRows, markdownIndex);
    const mapped = mapTaskRows(taskRows, projectIndex, markdownIndex);
    const filtered = mapped.filter((task) => {
      const projectInfo = projectIndex.get(task.project);
      return includesErpKeyword(
        task.title,
        task.project,
        task.phase,
        task.notes,
        projectInfo?.summary || '',
        projectInfo?.markdown || ''
      );
    });

    return {
      tasks: filtered,
      totalTaskRows: taskRows.length,
      importedTaskCandidates: filtered.length,
      ignoredTaskRows: Math.max(0, taskRows.length - filtered.length),
      projectCount: projectRows.length,
      erpProjectCount: [...projectIndex.values()].filter((project) => includesErpKeyword(project.title, project.summary, project.markdown)).length,
      markdownCount: entries.filter((entry) => entry.name.endsWith('.md')).length,
      csvFiles: entries.filter((entry) => entry.name.endsWith('.csv')).map((entry) => entry.name),
      markdownFiles: entries.filter((entry) => entry.name.endsWith('.md')).map((entry) => entry.name),
      taskCsvName: taskCsv.name,
      projectCsvName: projectCsv?.name || '',
    };
  };

  window.PlanningExportImport = { analyze };
})();
