// 화면 전환(주소 #해시 기반)과 모듈 연결.
//   #/                 서재
//   #/f/<책>           책의 페이지 목록
//   #/f/<책>/p/<페이지> 읽기

(async () => {
  const $ = id => document.getElementById(id);
  const views = { library: $('library-view'), folder: $('folder-view'), reader: $('reader') };
  const breadcrumb = $('breadcrumb');
  const btnPrevPage = $('btn-prev-page');
  const btnNextPage = $('btn-next-page');

  let current = { folder: null, page: null };
  let autoplayNext = false;

  function show(name) {
    for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
    $('reader-tools').hidden = name !== 'reader';
  }

  function renderBreadcrumb(parts) {
    breadcrumb.textContent = '';
    parts.forEach(([text, href], i) => {
      if (i) breadcrumb.append(' › ');
      const node = document.createElement(href ? 'a' : 'span');
      node.textContent = text;
      if (href) node.href = href;
      breadcrumb.append(node);
    });
  }

  async function route() {
    const m = location.hash.match(/^#\/f\/(\w+)(?:\/p\/(\w+)(?:\/s\/(\d+))?)?/);
    const folderId = m?.[1];
    const pageId = m?.[2];
    const startAt = m?.[3] != null ? Number(m[3]) : null;

    if (Reader.page && Reader.page.id !== pageId) Reader.close();

    if (!folderId) {
      current = { folder: null, page: null };
      show('library');
      renderBreadcrumb([['📚 서재']]);
      await LibraryView.renderLibrary();
      return;
    }

    if (!pageId) {
      show('folder');
      const folder = await LibraryView.renderFolder(folderId);
      if (!folder) return;
      current = { folder, page: null };
      renderBreadcrumb([['📚 서재', '#/'], [folder.name]]);
      return;
    }

    const [folder, page] = await Promise.all([Library.getFolder(folderId), Library.getPage(pageId)]);
    if (!folder || !page) { location.hash = folder ? `#/f/${folderId}` : '#/'; return; }
    current = { folder, page };

    folder.lastPageId = page.id;
    await Library.saveFolder(folder);

    const idx = folder.pageIds.indexOf(page.id);
    renderBreadcrumb([
      ['📚 서재', '#/'],
      [folder.name, `#/f/${folder.id}`],
      [`${page.name} (${idx + 1}/${folder.pageIds.length})`],
    ]);
    btnPrevPage.disabled = idx <= 0;
    btnNextPage.textContent = idx < folder.pageIds.length - 1 ? '다음 페이지 ▶' : '다 읽음 ✓';

    show('reader');
    const autoplay = autoplayNext;
    autoplayNext = false;
    if (Reader.page?.id !== page.id) Reader.open(page, { autoplay, startAt });
  }

  function pageHref(offset) {
    const { folder, page } = current;
    const id = folder.pageIds[folder.pageIds.indexOf(page.id) + offset];
    return id ? `#/f/${folder.id}/p/${id}` : null;
  }

  // 페이지를 끝까지 읽으면 다음 페이지로. 마지막 페이지면 책 목록으로.
  Reader.init({
    onPageEnd(page, { autoplay }) {
      const next = pageHref(1);
      if (next) {
        autoplayNext = autoplay;
        location.hash = next;
      } else {
        const { id, name } = current.folder;
        location.hash = `#/f/${id}`;
        setTimeout(() => alert(`🎉 "${name}"을(를) 끝까지 읽었어요!`), 100);
      }
    },
  });

  btnPrevPage.addEventListener('click', () => { const h = pageHref(-1); if (h) location.hash = h; });
  btnNextPage.addEventListener('click', () => Reader.finishPage({ continuePlaying: false }));

  // 사진 OCR / 붙여넣기 결과 처리
  OCR.init({
    async onDone(text, mode, name) {
      const { folder } = current;
      if (!folder) return;
      if (mode === 'append' && Reader.page) {
        const page = Reader.page;
        await Library.setPageText(page, page.text.trimEnd() + '\n\n' + text);
        Reader.open(page);
        return;
      }
      const page = await Library.createPage(folder, name, text);
      if (current.page) location.hash = `#/f/${folder.id}/p/${page.id}`;
      else LibraryView.renderFolder(folder.id);
    },
  });

  for (const [id, mode] of [['btn-reader-ocr', 'photo'], ['btn-reader-paste', 'paste']]) {
    $(id).addEventListener('click', () => {
      OCR.open({ defaultName: `페이지 ${current.folder.pageIds.length + 1}`, canAppend: true, mode });
    });
  }

  Translate.init(msg => { $('translator-status').textContent = msg; });

  window.addEventListener('hashchange', route);
  await Library.migrateLegacy();
  route();
})();
