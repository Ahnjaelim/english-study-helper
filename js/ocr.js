// 책 사진 → 텍스트 (Tesseract.js, 브라우저 안에서 실행).
// 인식 결과에서 쪽번호/머리글 제거, 하이픈 단어 붙이기, 줄바꿈 정리를 한 뒤 편집 화면에 보여준다.

const OCR = (() => {
  const MAX_SIDE = 2400; // 큰 사진은 줄여서 속도를 높인다

  let workerPromise = null;
  let onLog = () => {};

  function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', 1, {
        logger: m => onLog(m),
      }).catch(err => {
        workerPromise = null;
        throw err;
      });
    }
    return workerPromise;
  }

  // 회색조 + 크기 축소. EXIF 회전은 createImageBitmap이 반영한다.
  async function preprocess(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.2)';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas;
  }

  async function recognize(file) {
    const worker = await getWorker();
    const canvas = await preprocess(file);
    const { data } = await worker.recognize(canvas);
    return data.text;
  }

  // ---------- 텍스트 정리 ----------
  const PAGE_NUMBER = /^[-–—\s]*\d{1,4}[-–—\s]*$/;
  const SENTENCE_END = /[.!?:"'”’)\]]$/;

  function normalizeKey(line) {
    return line.toLowerCase().replace(/[^a-z]/g, '');
  }

  // 한 페이지의 OCR 결과 → 문단 배열
  function pageToParagraphs(text) {
    let lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
    lines = lines.filter(l => !PAGE_NUMBER.test(l));

    const paragraphs = [];
    let cur = '';
    for (const line of lines) {
      if (!line) {
        if (cur) paragraphs.push(cur);
        cur = '';
        continue;
      }
      cur = joinLine(cur, line);
    }
    if (cur) paragraphs.push(cur);
    return paragraphs;
  }

  // 줄 끝 하이픈 + 다음 줄 소문자 시작이면 하이픈을 지우고 붙인다 (beauti- / ful → beautiful).
  function joinLine(a, b) {
    if (!a) return b;
    if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
    return a + ' ' + b;
  }

  // 머리글: 짧고, 숫자로 시작/끝나거나 전부 대문자이거나, 여러 페이지 첫 줄에 반복되는 줄
  function isRunningHeader(p, repeated) {
    if (p.length > 60) return false;
    if (repeated.has(normalizeKey(p))) return true;
    if (/^\d+\s|\s\d+$/.test(p)) return true;
    return /[A-Z]/.test(p) && p === p.toUpperCase() && !SENTENCE_END.test(p);
  }

  function cleanPages(pageTexts) {
    const pages = pageTexts.map(pageToParagraphs);

    const firstLineCount = new Map();
    for (const p of pages) {
      const key = p[0] && normalizeKey(p[0]);
      if (key) firstLineCount.set(key, (firstLineCount.get(key) || 0) + 1);
    }
    const repeated = new Set([...firstLineCount].filter(([, n]) => n > 1).map(([k]) => k));

    const result = [];
    for (const paras of pages) {
      if (paras.length > 1 && isRunningHeader(paras[0], repeated)) paras.shift();
      paras.forEach((para, i) => {
        // 이전 페이지 마지막 문단이 문장 중간에서 끝났으면 이어 붙인다.
        const prev = result[result.length - 1];
        if (i === 0 && prev && !SENTENCE_END.test(prev)) {
          result[result.length - 1] = joinLine(prev, para);
        } else {
          result.push(para);
        }
      });
    }
    return result.join('\n\n');
  }

  // ---------- 화면 ----------
  function init({ onDone }) {
    const $ = id => document.getElementById(id);
    const dialog = $('ocr-dialog');
    const input = $('ocr-input');
    const thumbs = $('ocr-thumbs');
    const btnRun = $('ocr-run');
    const status = $('ocr-status');
    const editor = $('ocr-text');
    const nameInput = $('ocr-name');
    const btnNew = $('ocr-new');
    const btnAppend = $('ocr-append');

    let files = [];
    let running = false;

    function renderThumbs() {
      thumbs.textContent = '';
      files.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'ocr-thumb';
        const img = document.createElement('img');
        img.src = f.url;
        img.title = f.file.name;
        const label = document.createElement('span');
        label.textContent = i + 1;
        const del = document.createElement('button');
        del.textContent = '✕';
        del.title = '빼기';
        del.disabled = running;
        del.addEventListener('click', () => {
          URL.revokeObjectURL(f.url);
          files.splice(i, 1);
          renderThumbs();
        });
        item.append(img, label, del);
        thumbs.append(item);
      });
      btnRun.disabled = running || !files.length;
    }

    function updateResultButtons() {
      const empty = !editor.value.trim();
      btnNew.disabled = empty;
      btnAppend.disabled = empty;
    }

    input.addEventListener('change', () => {
      // 휴대폰 사진은 파일 이름이 촬영 시각 순이라 이름순으로 정렬한다.
      const added = [...input.files]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map(file => ({ file, url: URL.createObjectURL(file) }));
      files.push(...added);
      input.value = '';
      renderThumbs();
    });

    btnRun.addEventListener('click', async () => {
      running = true;
      renderThumbs();
      const texts = [];
      let page = 0;
      onLog = m => {
        if (m.status === 'recognizing text') {
          status.textContent = `인식 중… ${page}/${files.length}장 (${Math.round(m.progress * 100)}%)`;
        } else if (m.status) {
          status.textContent = `OCR 엔진 준비 중… (첫 실행 시 다운로드) ${m.status}`;
        }
      };
      try {
        for (const f of files) {
          page++;
          texts.push(await recognize(f.file));
        }
        const cleaned = cleanPages(texts);
        editor.value = editor.value.trim() ? editor.value.trim() + '\n\n' + cleaned : cleaned;
        status.textContent = `완료: ${files.length}장. 오타를 고친 뒤 아래 버튼을 누르세요.`;
        files.forEach(f => URL.revokeObjectURL(f.url));
        files = [];
      } catch (err) {
        console.error(err);
        status.textContent = 'OCR 실패: ' + (err.message || err) + ' (인터넷 연결을 확인하세요)';
      } finally {
        running = false;
        renderThumbs();
        updateResultButtons();
      }
    });

    editor.addEventListener('input', updateResultButtons);

    async function finish(mode) {
      const text = editor.value.trim();
      const name = nameInput.value.trim() || '이름 없는 페이지';
      dialog.close();
      editor.value = '';
      status.textContent = '';
      updateResultButtons();
      await onDone(text, mode, name);
    }
    btnNew.addEventListener('click', () => finish('new'));
    btnAppend.addEventListener('click', () => finish('append'));
    $('ocr-close').addEventListener('click', () => dialog.close());

    // defaultName: 새 페이지 기본 이름, canAppend: 읽기 화면에서 열었을 때만 "이어 붙이기" 표시
    openDialog = ({ defaultName, canAppend }) => {
      nameInput.value = defaultName;
      btnAppend.hidden = !canAppend;
      renderThumbs();
      updateResultButtons();
      dialog.showModal();
    };
  }

  let openDialog = () => {};

  return { init, open: opts => openDialog(opts), cleanPages };
})();
