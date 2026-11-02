// 서재 데이터 (IndexedDB).
// folder: { id, name, pageIds: [순서대로], lastPageId, createdAt, updatedAt }
// page:   { id, folderId, name, text, pos, total, done, updatedAt }

const Library = (() => {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('english-study-helper', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('folders', { keyPath: 'id' });
          db.createObjectStore('pages', { keyPath: 'id' }).createIndex('folderId', 'folderId');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function store(name, mode = 'readonly') {
    return (await open()).transaction(name, mode).objectStore(name);
  }

  const get = async (s, id) => wrap((await store(s)).get(id));
  const getAll = async s => wrap((await store(s)).getAll());
  const put = async (s, value) => wrap((await store(s, 'readwrite')).put(value));
  const del = async (s, id) => wrap((await store(s, 'readwrite')).delete(id));

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const countSentences = text => TextParser.parse(text).flat().length;

  // ---------- 폴더 ----------
  async function listFolders() {
    const folders = await getAll('folders');
    return folders.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const getFolder = id => get('folders', id);

  async function createFolder(name) {
    const now = Date.now();
    const folder = { id: uid(), name, pageIds: [], lastPageId: null, createdAt: now, updatedAt: now };
    await put('folders', folder);
    return folder;
  }

  async function saveFolder(folder) {
    folder.updatedAt = Date.now();
    await put('folders', folder);
  }

  async function deleteFolder(id) {
    const pages = await wrap((await store('pages')).index('folderId').getAllKeys(id));
    for (const pageId of pages) await del('pages', pageId);
    await del('folders', id);
  }

  // ---------- 페이지 ----------
  const getPage = id => get('pages', id);

  async function listPages(folder) {
    const pages = await Promise.all(folder.pageIds.map(getPage));
    return pages.filter(Boolean);
  }

  async function allPages() {
    return getAll('pages');
  }

  async function createPage(folder, name, text) {
    const page = {
      id: uid(), folderId: folder.id, name, text,
      pos: 0, total: countSentences(text), done: false, updatedAt: Date.now(),
    };
    await put('pages', page);
    folder.pageIds.push(page.id);
    await saveFolder(folder);
    return page;
  }

  async function savePage(page) {
    page.updatedAt = Date.now();
    await put('pages', page);
  }

  async function setPageText(page, text) {
    page.text = text;
    page.total = countSentences(text);
    await savePage(page);
  }

  // ---------- 페이지 수정 ----------
  // 문장들을 공백 하나로 이은 문자열. 형광펜 text도 같은 방식(공백 정규화)으로 저장돼 있다.
  function flatten(text) {
    const sents = TextParser.parse(text).flat();
    const starts = [];
    let flat = '';
    sents.forEach((s, i) => {
      if (i) flat += ' ';
      starts.push(flat.length);
      flat += s;
    });
    return { sents, starts, flat };
  }

  function fromFlat(f, x) {
    let s = f.starts.length - 1;
    while (s > 0 && f.starts[s] > x) s--;
    return { s, o: x - f.starts[s] };
  }

  // haystack에서 needle이 나오는 위치 중 near에 가장 가까운 곳 (없으면 -1)
  function nearestIndexOf(haystack, needle, near) {
    let best = -1;
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
      if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
    }
    return best;
  }

  // 본문/이름 수정. 형광펜과 읽던 위치는 같은 글을 새 본문에서 찾아 옮긴다.
  // 반환값: 찾지 못해 빠진 형광펜 수
  async function editPage(page, { name, text }) {
    page.name = name;
    if (text === page.text) {
      await savePage(page);
      return 0;
    }

    const a = flatten(page.text);
    const b = flatten(text);
    const highlights = [];
    for (const h of page.highlights || []) {
      const oldAt = (a.starts[h.start.s] ?? 0) + h.start.o;
      const at = nearestIndexOf(b.flat, h.text, oldAt);
      if (at < 0) continue;
      highlights.push({ ...h, start: fromFlat(b, at), end: fromFlat(b, at + h.text.length) });
    }
    const lost = (page.highlights?.length || 0) - highlights.length;

    const curSentence = a.sents[page.pos];
    const posAt = curSentence ? nearestIndexOf(b.flat, curSentence, a.starts[page.pos]) : -1;
    page.pos = posAt >= 0 ? fromFlat(b, posAt).s : Math.min(page.pos, Math.max(0, b.sents.length - 1));

    page.highlights = highlights;
    await setPageText(page, text);
    return lost;
  }

  async function deletePage(folder, pageId) {
    folder.pageIds = folder.pageIds.filter(id => id !== pageId);
    if (folder.lastPageId === pageId) folder.lastPageId = null;
    await del('pages', pageId);
    await saveFolder(folder);
  }

  // 예전 버전(localStorage에 문서 하나)에서 옮겨오기
  async function migrateLegacy() {
    const raw = localStorage.getItem('esh.doc');
    if (!raw) return;
    try {
      const doc = JSON.parse(raw);
      if (doc?.text) {
        const folder = await createFolder('내 문서');
        const page = await createPage(folder, doc.name || '문서', doc.text);
        page.pos = Number(localStorage.getItem('esh.pos')) || 0;
        await savePage(page);
      }
    } finally {
      localStorage.removeItem('esh.doc');
      localStorage.removeItem('esh.pos');
    }
  }

  return {
    listFolders, getFolder, createFolder, saveFolder, deleteFolder,
    getPage, listPages, allPages, createPage, savePage, setPageText, editPage, deletePage,
    migrateLegacy,
  };
})();
