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
    getPage, listPages, allPages, createPage, savePage, setPageText, deletePage,
    migrateLegacy,
  };
})();
