// 서재(책 목록)와 책(페이지 목록) 화면.

const LibraryView = (() => {
  const $ = id => document.getElementById(id);

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function iconButton(text, title, onClick) {
    return el('button', {
      textContent: text,
      title,
      className: 'icon-btn',
      onclick: e => { e.preventDefault(); e.stopPropagation(); onClick(); },
    });
  }

  function pageProgress(p) {
    if (p.done) return '✓ 완료';
    if (p.pos > 0 && p.total) return Math.round(((p.pos + 1) / p.total) * 100) + '%';
    return '';
  }

  // ---------- 서재 ----------
  const grid = $('folder-grid');

  async function renderLibrary() {
    const [folders, pages] = await Promise.all([Library.listFolders(), Library.allPages()]);
    const byId = new Map(pages.map(p => [p.id, p]));

    grid.textContent = '';
    $('library-empty').hidden = folders.length > 0;

    for (const f of folders) {
      const fp = f.pageIds.map(id => byId.get(id)).filter(Boolean);
      const done = fp.filter(p => p.done).length;
      const pct = fp.length ? Math.round((done / fp.length) * 100) : 0;

      grid.append(el('a', { className: 'folder-card', href: `#/f/${f.id}` },
        el('div', { className: 'folder-icon', textContent: '📖' }),
        el('div', { className: 'folder-name', textContent: f.name }),
        el('div', { className: 'folder-meta', textContent: `${fp.length}페이지 · ${done}페이지 완료` }),
        el('div', { className: 'bar' }, el('span', { style: `width:${pct}%` })),
        el('div', { className: 'card-actions' },
          iconButton('✏️', '이름 바꾸기', () => renameFolder(f, renderLibrary)),
          iconButton('🗑', '삭제', async () => {
            if (!confirm(`"${f.name}" 책과 안의 페이지 ${fp.length}개를 모두 삭제할까요?`)) return;
            await Library.deleteFolder(f.id);
            renderLibrary();
          }),
        ),
      ));
    }
  }

  async function renameFolder(folder, after) {
    const name = prompt('책 이름', folder.name)?.trim();
    if (!name || name === folder.name) return;
    folder.name = name;
    await Library.saveFolder(folder);
    after();
  }

  $('btn-new-folder').addEventListener('click', async () => {
    const name = prompt('새 책(폴더) 이름', '')?.trim();
    if (!name) return;
    const folder = await Library.createFolder(name);
    location.hash = `#/f/${folder.id}`;
  });

  // ---------- 책 (페이지 목록) ----------
  const list = $('page-list');
  const folderView = $('folder-view');
  let folder = null;
  let dragId = null;

  async function renderFolder(id) {
    folder = await Library.getFolder(id);
    if (!folder) { location.hash = '#/'; return null; }

    $('folder-title').textContent = folder.name;
    const pages = await Library.listPages(folder);
    $('folder-empty').hidden = pages.length > 0;
    $('btn-continue').disabled = !pages.length;

    list.textContent = '';
    pages.forEach((p, i) => {
      const li = el('li', {
        className: 'page-row' + (p.id === folder.lastPageId ? ' last' : '') + (p.done ? ' done' : ''),
        draggable: true,
      },
        el('span', { className: 'drag-handle', textContent: '⠿', title: '끌어서 순서 변경' }),
        el('span', { className: 'page-no', textContent: i + 1 }),
        el('a', { className: 'page-name', href: `#/f/${folder.id}/p/${p.id}`, textContent: p.name }),
        el('span', { className: 'page-progress', textContent: pageProgress(p) }),
        iconButton('✏️', '이름·내용 수정', () => editPage(p, () => renderFolder(folder.id))),
        iconButton('↑', '위로', () => move(p.id, -1)),
        iconButton('↓', '아래로', () => move(p.id, 1)),
        iconButton('🗑', '삭제', async () => {
          if (!confirm(`"${p.name}" 페이지를 삭제할까요?`)) return;
          await Library.deletePage(folder, p.id);
          renderFolder(folder.id);
        }),
      );
      li.dataset.id = p.id;
      list.append(li);
    });
    renderHighlightList(pages);
    return folder;
  }

  // 책 전체의 형광펜을 페이지 순서대로 모아 보여준다. 클릭하면 그 문장으로 이동.
  function renderHighlightList(pages) {
    const items = pages.flatMap(p => (p.highlights || []).map(h => ({ p, h })));
    $('highlight-section').hidden = !items.length;
    $('highlight-count').textContent = `${items.length}개`;
    const ul = $('highlight-list');
    ul.textContent = '';
    for (const { p, h } of items) {
      const colorButtons = ['yellow', 'green', 'blue', 'pink'].map(c => {
        const b = iconButton('', '이 색으로 바꾸기', () => updateHighlight(p, h, { color: c }));
        b.className = 'hl-btn' + (c === h.color ? ' current' : '');
        b.dataset.color = c;
        return b;
      });
      ul.append(el('li', { className: `hl-item hl-${h.color}` },
        el('a', { href: `#/f/${folder.id}/p/${p.id}/s/${h.start.s}` },
          el('div', { className: 'hl-text', textContent: h.text }),
          h.translation ? el('div', { className: 'hl-translation', textContent: h.translation }) : '',
          el('div', { className: 'hl-page', textContent: p.name }),
        ),
        el('div', { className: 'hl-actions' },
          ...colorButtons,
          iconButton('✏️', '뜻·번역 수정', () => {
            const t = prompt(`"${h.text.slice(0, 40)}"의 뜻/번역`, h.translation || '');
            if (t != null) updateHighlight(p, h, { translation: t.trim() });
          }),
          iconButton('🗑', '형광펜 삭제', () => {
            if (confirm(`이 형광펜을 삭제할까요?\n"${h.text.slice(0, 60)}"`)) updateHighlight(p, h, null);
          }),
        ),
      ));
    }
  }

  // changes가 null이면 삭제, 아니면 색/번역 수정
  async function updateHighlight(page, h, changes) {
    page.highlights = changes
      ? page.highlights.map(x => (x.id === h.id ? { ...x, ...changes } : x))
      : page.highlights.filter(x => x.id !== h.id);
    await Library.savePage(page);
    renderFolder(folder.id);
  }

  // 페이지 이름·본문 수정 창을 열고, 저장되면 after()로 화면을 갱신한다.
  function editPage(page, after) {
    OCR.open({
      mode: 'edit',
      defaultName: page.name,
      text: page.text,
      async onSave(text, name) {
        const lost = await Library.editPage(page, { name, text });
        await after();
        if (lost) alert(`고친 부분에 있던 형광펜 ${lost}개는 새 본문에서 찾을 수 없어 지워졌어요.`);
      },
    });
  }

  async function move(id, delta) {
    const ids = folder.pageIds;
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await Library.saveFolder(folder);
    renderFolder(folder.id);
  }

  // 행 끌어서 순서 변경
  function clearDropMarks() {
    list.querySelectorAll('.drop-before, .drop-after').forEach(r => r.classList.remove('drop-before', 'drop-after'));
  }

  list.addEventListener('dragstart', e => {
    const row = e.target.closest('.page-row');
    if (!row) return;
    dragId = row.dataset.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragend', () => {
    dragId = null;
    clearDropMarks();
    list.querySelectorAll('.dragging').forEach(r => r.classList.remove('dragging'));
  });

  list.addEventListener('dragover', e => {
    const row = e.target.closest('.page-row');
    if (!dragId || !row) return;
    e.preventDefault();
    clearDropMarks();
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });

  list.addEventListener('drop', async e => {
    const row = e.target.closest('.page-row');
    if (!dragId || !row) return;
    e.preventDefault();
    e.stopPropagation();
    const after = row.classList.contains('drop-after');
    const ids = folder.pageIds.filter(id => id !== dragId);
    let at = ids.indexOf(row.dataset.id);
    if (at < 0) at = ids.length; else if (after) at++;
    ids.splice(at, 0, dragId);
    folder.pageIds = ids;
    dragId = null;
    await Library.saveFolder(folder);
    renderFolder(folder.id);
  });

  // txt 파일 추가 (버튼 또는 끌어다 놓기)
  async function addTextFiles(files) {
    const txts = [...files]
      .filter(f => f.type === 'text/plain' || /\.txt$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const f of txts) {
      await Library.createPage(folder, f.name.replace(/\.txt$/i, ''), await f.text());
    }
    renderFolder(folder.id);
  }

  const fileInput = $('file-input');
  fileInput.addEventListener('change', async () => {
    await addTextFiles(fileInput.files);
    fileInput.value = '';
  });

  folderView.addEventListener('dragover', e => {
    if (dragId || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    folderView.classList.add('dragover');
  });
  folderView.addEventListener('dragleave', e => {
    if (e.target === folderView) folderView.classList.remove('dragover');
  });
  folderView.addEventListener('drop', e => {
    if (dragId || !e.dataTransfer.files.length) return;
    e.preventDefault();
    folderView.classList.remove('dragover');
    addTextFiles(e.dataTransfer.files);
  });

  $('btn-rename-folder').addEventListener('click', () => renameFolder(folder, () => renderFolder(folder.id)));

  // 이어 읽기: 마지막으로 읽던 페이지가 안 끝났으면 그 페이지, 끝났으면 그 다음 안 읽은 페이지
  $('btn-continue').addEventListener('click', async () => {
    const pages = await Library.listPages(folder);
    if (!pages.length) return;
    const lastIdx = Math.max(0, pages.findIndex(p => p.id === folder.lastPageId));
    const target = pages.slice(lastIdx).find(p => !p.done) || pages.find(p => !p.done) || pages[lastIdx];
    location.hash = `#/f/${folder.id}/p/${target.id}`;
  });

  for (const [id, mode] of [['btn-folder-ocr', 'photo'], ['btn-folder-paste', 'paste']]) {
    $(id).addEventListener('click', () => {
      OCR.open({ defaultName: `페이지 ${folder.pageIds.length + 1}`, canAppend: false, mode });
    });
  }

  return { renderLibrary, renderFolder, editPage };
})();
