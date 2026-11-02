// 영→한 번역과 영영사전 조회.
// 1순위: Chrome 내장 Translator API (온디바이스, 무료, 무제한)
// 2순위: MyMemory 무료 API (온라인, 하루 약 5000자 제한, 요청당 500바이트 제한)

const Translate = (() => {
  const cache = new Map();
  let translatorPromise = null;
  let onStatus = () => {};

  function hasBuiltin() {
    return 'Translator' in self;
  }

  async function builtinAvailability() {
    if (!hasBuiltin()) return 'unavailable';
    try {
      return await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ko' });
    } catch {
      return 'unavailable';
    }
  }

  // 모델 다운로드가 필요한 경우 사용자 동작(드래그 직후) 안에서 호출돼야 한다.
  function getBuiltinTranslator() {
    if (!translatorPromise) {
      translatorPromise = Translator.create({
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        monitor(m) {
          m.addEventListener('downloadprogress', e => {
            onStatus(`번역 모델 다운로드 중… ${Math.round(e.loaded * 100)}%`);
          });
        },
      }).then(t => {
        onStatus('번역: Chrome 내장 번역기');
        return t;
      }).catch(err => {
        translatorPromise = null;
        throw err;
      });
    }
    return translatorPromise;
  }

  async function translateWithMyMemory(text) {
    const url = 'https://api.mymemory.translated.net/get?langpair=en|ko&q=' + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data = await res.json();
    const out = data?.responseData?.translatedText;
    if (data.responseStatus !== 200 || !out || /MYMEMORY WARNING/i.test(out)) {
      throw new Error(data.responseDetails || out || '번역 실패');
    }
    return out;
  }

  // MyMemory는 요청당 500바이트 제한이 있어 문장 단위로 쪼개 보낸다.
  async function translateChunked(text) {
    const encoder = new TextEncoder();
    if (encoder.encode(text).length <= 450) return translateWithMyMemory(text);
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const chunks = [];
    let cur = '';
    for (const p of parts) {
      if (cur && encoder.encode(cur + p).length > 450) { chunks.push(cur); cur = ''; }
      cur += p;
    }
    if (cur) chunks.push(cur);
    const results = [];
    for (const c of chunks) results.push(await translateWithMyMemory(c.trim()));
    return results.join(' ');
  }

  async function translate(text) {
    const key = text.trim();
    if (cache.has(key)) return cache.get(key);

    let result;
    if ((await builtinAvailability()) !== 'unavailable') {
      try {
        const t = await getBuiltinTranslator();
        result = await t.translate(key);
      } catch (err) {
        console.warn('Built-in translator failed, falling back:', err);
      }
    }
    if (result == null) {
      result = await translateChunked(key);
      onStatus('번역: MyMemory (온라인)');
    }
    cache.set(key, result);
    return result;
  }

  // dictionaryapi.dev 무료 영영사전. 없으면 null.
  async function lookup(word) {
    const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word.toLowerCase()));
    if (!res.ok) return null;
    const entries = await res.json();
    if (!Array.isArray(entries) || !entries.length) return null;

    const phonetic = entries.map(e => e.phonetic || e.phonetics?.find(p => p.text)?.text).find(Boolean) || '';
    const meanings = [];
    for (const e of entries) {
      for (const m of e.meanings || []) {
        let group = meanings.find(g => g.partOfSpeech === m.partOfSpeech);
        if (!group) meanings.push(group = { partOfSpeech: m.partOfSpeech, definitions: [] });
        for (const d of m.definitions || []) {
          if (group.definitions.length < 3) group.definitions.push(d.definition);
        }
      }
    }
    return { phonetic, meanings };
  }

  async function init(statusCb) {
    onStatus = statusCb;
    const a = await builtinAvailability();
    if (a === 'available') onStatus('번역: Chrome 내장 번역기');
    else if (a === 'downloadable' || a === 'downloading') onStatus('번역: Chrome 내장 번역기 (첫 사용 시 모델 다운로드)');
    else onStatus('번역: MyMemory (온라인)');
  }

  return { init, translate, lookup };
})();
