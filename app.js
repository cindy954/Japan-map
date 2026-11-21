/* app.js — 화면 조작 + AI 비전(기본) · 브라우저 OCR(폴백) + 결과 카드 */
(function () {
  'use strict';

  var P = window.FoodParser;
  if (!P) {
    console.error('parser.js를 불러오지 못했어요.');
    return;
  }

  var $ = function (id) { return document.getElementById(id); };

  var MAX_PHOTOS = 12;
  var MAX_ITEMS = 120;

  var TESSERACT_SOURCES = [
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'
  ];

  /* AI 비전 프록시 (Cloudflare Worker) — 사진에서 일본어 가게명만 뽑아 옵니다.
     네트워크 오류·429(무료 한도)·5xx로 실패하면 Tesseract.js 브라우저 OCR로 자동 폴백해요. */
  var VISION_ENDPOINT = 'https://polished-shape-141d.rlatlsel12.workers.dev';
  var VISION_MAX_SIDE = 1400;
  var VISION_QUALITY = 0.85;
  var VISION_TIMEOUT_MS = 25000;
  var FALLBACK_BADGE = 'AI 한도 초과/연결 지연으로 기본 OCR 모드로 전환했어요';

  var STATUS_LABEL = {
    'loading tesseract core': 'OCR 엔진 내려받는 중',
    'initializing tesseract': 'OCR 엔진 켜는 중',
    'loading language traineddata': '일본어 데이터 내려받는 중',
    'initializing api': '인식 준비 중',
    'recognizing text': '글자 읽는 중'
  };

  var SAMPLE = [
    '오사카·나고야에서 진짜 맛있었던 곳만 정리해둘게요 🍜',
    '',
    '1. だるま 新世界総本店',
    '   신세카이 소스 두 번 찍는 그 집, 줄 길어도 회전 빨라요',
    '2. 自由軒 難波本店',
    '   명물 인디안 카레, 비비는 순간이 포인트',
    '3. あつた蓬莱軒 本店',
    '   나고야 히쓰마부시 원조, 웨이팅 30분은 기본이에요',
    '4. 矢場とん 本店',
    '   미소카츠 처음 먹는 사람도 좋아할 맛',
    '',
    '⏰ 11:00-22:00 (브레이크 15:00-17:00)',
    'https://blog.naver.com/cindylog-'
  ].join('\n');

  var state = {
    regionId: 'all',
    tab: 'photo',
    items: [],
    photos: [],
    busy: false,
    visionOff: false,
    seq: 0,
    mergeMode: false,
    mergeSel: {}
  };

  var tesseractPromise = null;
  var ocrWorker = null;
  var ocrWorkerPromise = null;
  var progressSink = null;
  var toastTimer = null;

  /* ---------------- 공통 유틸 ---------------- */

  function uid() { state.seq += 1; return 'i' + state.seq; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      if (c === '&') return '&amp;';
      if (c === '<') return '&lt;';
      if (c === '>') return '&gt;';
      if (c === '"') return '&quot;';
      return '&#39;';
    });
  }

  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function region() { return P.getRegion(state.regionId); }

  /* ---------------- 지역 칩 ---------------- */

  function renderRegions() {
    var box = $('region-chips');
    box.innerHTML = P.REGIONS.map(function (r) {
      return '<button class="chip" type="button" data-region="' + r.id + '" aria-pressed="' +
        (r.id === state.regionId ? 'true' : 'false') + '">' + esc(r.label) + '</button>';
    }).join('');
  }

  function setRegion(id) {
    state.regionId = id;
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
      chip.setAttribute('aria-pressed', chip.getAttribute('data-region') === id ? 'true' : 'false');
    });
    $('result-region').textContent = region().label;
    renderResults();
  }

  /* ---------------- 탭 ---------------- */

  function setTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      var active = tab.getAttribute('data-tab') === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('panel-photo').hidden = name !== 'photo';
    $('panel-text').hidden = name !== 'text';
  }

  /* ---------------- 사진 ---------------- */

  function addPhotos(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var images = files.filter(function (f) {
      return /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(f.name || '');
    });
    if (!images.length) {
      toast('이미지 파일만 올릴 수 있어요');
      return;
    }
    var room = MAX_PHOTOS - state.photos.length;
    if (room <= 0) {
      toast('사진은 한 번에 ' + MAX_PHOTOS + '장까지예요');
      return;
    }
    if (images.length > room) {
      toast('사진은 ' + MAX_PHOTOS + '장까지만 담을게요');
      images = images.slice(0, room);
    }
    images.forEach(function (file) {
      state.photos.push({
        id: uid(),
        file: file,
        url: (window.URL && URL.createObjectURL) ? URL.createObjectURL(file) : '',
        status: 'ready',
        progress: 0,
        text: '',
        error: ''
      });
    });
    renderPhotos();
  }

  function removePhoto(id) {
    state.photos = state.photos.filter(function (p) {
      if (p.id === id) {
        if (p.url) URL.revokeObjectURL(p.url);
        return false;
      }
      return true;
    });
    renderPhotos();
  }

  function clearPhotos() {
    state.photos.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    state.photos = [];
    $('file-input').value = '';
    renderPhotos();
    showProgress(false);
  }

  function renderPhotos() {
    var box = $('thumbs');
    var has = state.photos.length > 0;
    box.hidden = !has;
    box.innerHTML = state.photos.map(function (p) {
      var badge = '';
      var cls = '';
      if (p.status === 'done') { badge = p.engine === 'ocr' ? 'OCR 완료' : 'AI 완료'; cls = ' is-done'; }
      else if (p.status === 'error') { badge = '실패'; cls = ' is-error'; }
      else if (p.status === 'working') {
        if (p.engine === 'ocr') badge = (p.progress > 0 ? Math.round(p.progress * 100) + '%' : 'OCR');
        else badge = 'AI';
      } else { badge = '대기'; }
      return '<figure class="thumb" data-photo="' + p.id + '">' +
        (p.url ? '<img src="' + esc(p.url) + '" alt="업로드한 캡쳐">' : '') +
        '<figcaption class="thumb-badge' + cls + '">' + badge + '</figcaption>' +
        '<button class="thumb-remove" type="button" data-act="remove-photo" aria-label="이 사진 빼기">✕</button>' +
        '</figure>';
    }).join('');

    var btn = $('run-ocr');
    if (btn) {
      btn.disabled = state.busy || !has;
      btn.textContent = state.busy ? '인식 중…' : '일본어 가게명 뽑기';
    }
    $('clear-photos').disabled = state.busy || !has;
    $('file-input').disabled = state.busy;
  }

  function updateThumbProgress(p) {
    var fig = document.querySelector('[data-photo="' + p.id + '"] .thumb-badge');
    if (!fig) return;
    fig.textContent = Math.round((p.progress || 0) * 100) + '%';
  }

  function showProgress(on) {
    $('progress').hidden = !on;
    if (!on) {
      $('bar-fill').style.width = '0%';
      $('progress-text').textContent = '준비 중…';
    }
  }

  function setProgress(ratio, label) {
    var r = Math.max(0, Math.min(1, ratio || 0));
    $('bar-fill').style.width = (r * 100).toFixed(1) + '%';
    $('progress-text').textContent = label;
  }

  /* ---------------- OCR ---------------- */

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise(function (resolve, reject) {
      var i = 0;
      function next() {
        if (i >= TESSERACT_SOURCES.length) {
          tesseractPromise = null;
          reject(new Error('OCR 라이브러리를 불러오지 못했어요. 네트워크를 확인해 주세요.'));
          return;
        }
        var s = document.createElement('script');
        s.src = TESSERACT_SOURCES[i];
        i += 1;
        s.async = true;
        s.onload = function () {
          if (window.Tesseract) resolve(window.Tesseract);
          else next();
        };
        s.onerror = next;
        document.head.appendChild(s);
      }
      next();
    });
    return tesseractPromise;
  }

  function ensureWorker() {
    if (ocrWorker) return Promise.resolve(ocrWorker);
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = loadTesseract().then(function (T) {
      return T.createWorker('jpn+eng+kor', 1, {
        logger: function (m) { if (progressSink) progressSink(m); },
        errorHandler: function (e) { console.warn('[tesseract]', e); }
      }).then(function (w) {
        return w.setParameters({ preserve_interword_spaces: '1' }).then(function () {
          ocrWorker = w;
          return w;
        });
      });
    }).catch(function (err) {
      ocrWorkerPromise = null;
      throw err;
    });
    return ocrWorkerPromise;
  }

  function loadImageEl(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { img.__url = url; resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('이미지를 열 수 없어요'));
      };
      img.src = url;
    });
  }

  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(function () { return loadImageEl(file); });
    }
    return loadImageEl(file);
  }

  /* OCR 전처리: 아주 큰 사진만 줄이고 나머지는 원본 그대로 넘깁니다.
     (회색조·대비 보정은 오히려 일본어 한자 인식률을 떨어뜨려서 넣지 않았어요) */
  function preprocess(file) {
    if (!file || !file.size) return Promise.resolve(file);
    return loadBitmap(file).then(function (src) {
      var sw = src.width || src.naturalWidth || 0;
      var sh = src.height || src.naturalHeight || 0;
      var longSide = Math.max(sw, sh);

      function release() {
        if (src.close) src.close();
        else if (src.__url) URL.revokeObjectURL(src.__url);
      }

      if (!sw || !sh || longSide <= 2400) {
        release();
        return file;
      }

      var scale = 2400 / longSide;
      var w = Math.max(1, Math.round(sw * scale));
      var h = Math.max(1, Math.round(sh * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (!ctx) { release(); return file; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      release();

      return new Promise(function (resolve) {
        if (!canvas.toBlob) { resolve(file); return; }
        canvas.toBlob(function (blob) { resolve(blob || file); }, 'image/png');
      });
    }).catch(function () {
      return file;
    });
  }

  /* ---------------- AI 비전 ---------------- */

  function fallbackDetail(err) {
    var kind = err && err.kind;
    if (kind === 'quota') return '무료 AI 인식 한도를 다 썼어요. 사진은 이 브라우저 안에서 직접 읽고, 결과는 그대로 나와요.';
    if (kind === 'timeout') return 'AI 응답이 느려서 사진을 브라우저 안에서 직접 읽고 있어요. 결과는 그대로 나와요.';
    if (kind === 'network') return 'AI 서버에 연결하지 못해 브라우저 안에서 직접 읽고 있어요. 결과는 그대로 나와요.';
    return 'AI 서버가 잠시 응답하지 않아 브라우저 안에서 직접 읽고 있어요. 결과는 그대로 나와요.';
  }

  function showEngineBadge(detail) {
    var el = $('engine-badge');
    if (!el) return;
    var text = $('engine-badge-text');
    var sub = $('engine-badge-detail');
    if (text) text.textContent = FALLBACK_BADGE;
    if (sub) { sub.textContent = detail || ''; sub.hidden = !detail; }
    el.hidden = false;
  }

  function hideEngineBadge() {
    var el = $('engine-badge');
    if (el) el.hidden = true;
  }

  /* 사진을 AI 서버로 보낼 형태로: 긴 변 1400px, JPEG 품질 0.85, base64 */
  function toVisionPayload(file) {
    return loadBitmap(file).then(function (src) {
      var sw = src.width || src.naturalWidth || 0;
      var sh = src.height || src.naturalHeight || 0;

      function release() {
        if (src.close) src.close();
        else if (src.__url) URL.revokeObjectURL(src.__url);
      }

      if (!sw || !sh) { release(); throw new Error('이미지를 읽지 못했어요'); }

      var scale = Math.min(1, VISION_MAX_SIDE / Math.max(sw, sh));
      var w = Math.max(1, Math.round(sw * scale));
      var h = Math.max(1, Math.round(sh * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (!ctx || typeof canvas.toDataURL !== 'function') {
        release();
        throw new Error('이미지를 변환하지 못했어요');
      }
      /* 투명 PNG가 검게 나오지 않게 흰 바탕 */
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      release();

      var dataUrl = canvas.toDataURL('image/jpeg', VISION_QUALITY);
      var comma = String(dataUrl || '').indexOf(',');
      if (comma === -1) throw new Error('이미지를 변환하지 못했어요');
      return { imageBase64: dataUrl.slice(comma + 1), mimeType: 'image/jpeg' };
    });
  }

  function visionError(kind, message) {
    var err = new Error(message || 'AI 인식 실패');
    err.kind = kind;
    return err;
  }

  /* POST { imageBase64, mimeType } → { places: [ … ] } */
  function callVision(payload) {
    if (typeof fetch !== 'function') return Promise.reject(visionError('network', 'fetch 없음'));

    var ctrl = null;
    try { if (typeof AbortController === 'function') ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* 무시 */ } }
    }, VISION_TIMEOUT_MS);

    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(VISION_ENDPOINT, opts).then(function (res) {
      clearTimeout(timer);
      if (!res || res.ok === false) {
        var status = (res && res.status) || 0;
        throw visionError(status === 429 ? 'quota' : (status >= 500 ? 'server' : 'request'), 'AI 서버 응답 ' + status);
      }
      return res.json().then(function (data) {
        var places = data && data.places;
        if (!Array.isArray(places)) throw visionError('format', 'AI 응답 형식 오류');
        return places;
      }, function () {
        throw visionError('format', 'AI 응답을 읽지 못했어요');
      });
    }, function (err) {
      clearTimeout(timer);
      if (err && err.kind) throw err;
      if (err && err.name === 'AbortError') throw visionError('timeout', 'AI 응답 시간 초과');
      throw visionError('network', 'AI 서버 연결 실패');
    });
  }

  /* ---------------- 인식 실행 (AI 비전 → 실패하면 OCR 폴백) ---------------- */

  function engineSummary(ctx) {
    var parts = [];
    if (ctx.visionCount) parts.push('AI ' + ctx.visionCount + '장');
    if (ctx.ocrCount) parts.push('OCR ' + ctx.ocrCount + '장');
    return parts.length ? parts.join(' + ') + ' 인식 · ' : '';
  }

  function stageLabel(ctx, index, p, label) {
    var ratio = (ctx.finished + (p && p.progress ? p.progress : 0)) / ctx.total;
    setProgress(ratio, (index + 1) + '/' + ctx.total + '장 · ' + label);
  }

  /* Tesseract.js 브라우저 OCR (폴백 엔진) */
  function ocrPhoto(p, index, ctx) {
    stageLabel(ctx, index, p, '브라우저 OCR 준비 중');

    progressSink = function (m) {
      if (!m || !m.status) return;
      var pr = typeof m.progress === 'number' ? m.progress : 0;
      if (m.status === 'recognizing text' && pr > 0) {
        p.progress = pr;
        updateThumbProgress(p);
      }
      var label = STATUS_LABEL[m.status] || '처리 중';
      if (pr > 0) label += ' ' + Math.round(pr * 100) + '%';
      stageLabel(ctx, index, p, label);
    };

    return preprocess(p.file).then(function (blob) {
      return ensureWorker().then(function (worker) { return worker.recognize(blob); });
    }).then(function (result) {
      progressSink = null;
      p.text = (result && result.data && result.data.text) || '';
      p.engine = 'ocr';
      ctx.ocrCount += 1;
      return ingestText(p.text, 'ocr');
    }, function (err) {
      progressSink = null;
      throw err;
    });
  }

  /* 사진 한 장: AI 먼저 → 실패하면 안내 배지 + OCR 폴백 */
  function recognizePhoto(p, index, ctx) {
    p.status = 'working';
    p.progress = 0;
    p.error = '';
    p.engine = ctx.visionOff ? 'ocr' : 'vision';
    renderPhotos();
    stageLabel(ctx, index, p, ctx.visionOff ? '브라우저 OCR 준비 중' : 'AI가 가게명 읽는 중');

    if (ctx.visionOff) return ocrPhoto(p, index, ctx);

    return toVisionPayload(p.file).then(callVision).then(function (places) {
      p.text = places.join('\n');
      p.engine = 'vision';
      p.progress = 1;
      ctx.visionCount += 1;
      return ingestPlaces(places, 'vision');
    }).catch(function (err) {
      /* 한도 소진은 새로고침 전까지 OCR로, 그 밖의 오류는 이번 묶음만 OCR로 */
      if (err && err.kind === 'quota') state.visionOff = true;
      ctx.visionOff = true;
      showEngineBadge(fallbackDetail(err));
      p.engine = 'ocr';
      p.progress = 0;
      renderPhotos();
      return ocrPhoto(p, index, ctx);
    });
  }

  function runRecognition() {
    if (state.busy) return;
    var pending = state.photos.filter(function (p) { return p.status !== 'done'; });
    if (!pending.length) {
      toast(state.photos.length ? '이미 인식한 사진이에요. 새 사진을 올려 주세요' : '먼저 캡쳐 사진을 올려 주세요');
      return;
    }

    state.busy = true;
    hideEngineBadge();
    renderPhotos();
    showProgress(true);

    var ctx = {
      total: pending.length,
      finished: 0,
      visionOff: state.visionOff,
      visionCount: 0,
      ocrCount: 0
    };
    var found = 0;
    var firstError = '';

    var chain = Promise.resolve();
    pending.forEach(function (p, index) {
      chain = chain.then(function () {
        return recognizePhoto(p, index, ctx).then(function (n) {
          found += n || 0;
          p.status = 'done';
          p.progress = 1;
        }).catch(function (err) {
          p.status = 'error';
          p.error = (err && err.message) || '인식 실패';
          if (!firstError) firstError = p.error;
        }).then(function () {
          progressSink = null;
          ctx.finished += 1;
          setProgress(ctx.finished / ctx.total, ctx.finished + '/' + ctx.total + '장 완료');
          renderPhotos();
        });
      });
    });

    chain.then(function () {
      state.busy = false;
      renderPhotos();
      showProgress(false);
      renderResults();
      if (found > 0) {
        $('excluded').open = false;
        scrollToResults();
        toast(engineSummary(ctx) + found + '개 가게 후보를 찾았어요');
      } else if (firstError && /network|fetch|Failed|en-US/i.test(firstError)) {
        toast('인식 데이터를 내려받지 못했어요. 네트워크 확인 후 다시 시도해 주세요');
      } else {
        toast('가게 이름을 못 찾았어요. 텍스트로 붙여넣기 해도 돼요');
      }
    });
  }

  /* ---------------- 항목 ---------------- */

  function ingestText(text, source) {
    return ingestParsed(P.parseText(text), source);
  }

  /* AI 비전 결과(가게 이름 배열) 담기 */
  function ingestPlaces(places, source) {
    return ingestParsed(P.parsePlaces(places), source);
  }

  function ingestParsed(parsed, source) {
    if (!parsed || !parsed.length) return 0;

    var seen = Object.create(null);
    state.items.forEach(function (it) { seen[P.dedupeKey(it.name) + '|' + (it.checked ? 'c' : 'n')] = true; });

    var added = 0;
    parsed.forEach(function (cand) {
      if (state.items.length >= MAX_ITEMS) return;
      var key = P.dedupeKey(cand.name) + '|' + (cand.checked ? 'c' : 'n');
      if (key && seen[key]) return;
      if (key) seen[key] = true;
      state.items.push({
        id: uid(),
        name: cand.name,
        checked: !!cand.checked,
        note: cand.note || '',
        reason: cand.reason || '',
        source: source
      });
      if (cand.checked) added += 1;
    });
    return added;
  }

  function checkedItems() {
    return state.items.filter(function (it) { return it.checked; });
  }

  /* 복사는 이름이 채워진 항목만 */
  function filledItems() {
    return checkedItems().filter(function (it) { return String(it.name).trim(); });
  }

  function excludedItems() {
    return state.items.filter(function (it) { return !it.checked; });
  }

  function scrollInto(el, opts) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try {
      el.scrollIntoView(opts || { behavior: 'smooth', block: 'start' });
    } catch (e) { /* 구형 브라우저는 무시 */ }
  }

  function scrollToResults() {
    var el = $('results');
    if (!el || el.hidden) return;
    scrollInto(el);
  }

  function cardHtml(it) {
    var maps = P.googleMapsUrl(it.name, state.regionId);
    var tabelog = P.tabelogUrl(it.name, state.regionId);
    var picked = !!state.mergeSel[it.id];
    var leftBox = state.mergeMode
      ? '<label class="check" title="합칠 줄 선택">' +
          '<input type="checkbox" data-act="merge-pick"' + (picked ? ' checked' : '') +
          ' aria-label="' + esc(it.name) + ' 합칠 줄로 선택">' +
          '<span class="check-mark" aria-hidden="true"></span>' +
        '</label>'
      : '<label class="check" title="목록에서 빼기">' +
          '<input type="checkbox" checked data-act="toggle" aria-label="' + esc(it.name) + ' 목록에서 빼기">' +
          '<span class="check-mark" aria-hidden="true"></span>' +
        '</label>';
    return '<article class="place' + (state.mergeMode ? ' is-merge' : '') + (picked ? ' is-picked' : '') +
      '" data-id="' + it.id + '">' +
      '<div class="place-main">' +
        leftBox +
        '<input class="place-name" type="text" value="' + esc(it.name) + '" data-act="rename" ' +
          'aria-label="가게 이름" spellcheck="false" autocomplete="off" autocapitalize="off">' +
        '<button class="icon-btn" type="button" data-act="remove" aria-label="이 항목 삭제">✕</button>' +
      '</div>' +
      (it.note ? '<p class="place-note">' + esc(it.note) + '</p>' : '') +
      '<div class="place-actions">' +
        '<a class="act act-map" href="' + esc(maps) + '" target="_blank" rel="noopener">' +
          '📍<span class="act-label">구글맵</span></a>' +
        '<a class="act act-tabelog" href="' + esc(tabelog) + '" target="_blank" rel="noopener">' +
          '🍽️<span class="act-label">타베로그</span></a>' +
        '<button class="act act-copy" type="button" data-act="copy">' +
          '📋<span class="act-label">이름 복사</span></button>' +
      '</div>' +
    '</article>';
  }

  function excludedHtml(it) {
    return '<div class="excluded-item" data-id="' + it.id + '">' +
      '<label class="check" title="결과로 올리기">' +
        '<input type="checkbox" data-act="restore" aria-label="' + esc(it.name) + ' 결과로 올리기">' +
        '<span class="check-mark" aria-hidden="true"></span>' +
      '</label>' +
      '<p class="excluded-text">' + esc(it.name) +
        (it.reason ? '<span class="reason">' + esc(it.reason) + '</span>' : '') +
      '</p>' +
    '</div>';
  }

  function renderResults() {
    var list = $('place-list');
    var excludedBox = $('excluded-list');
    var box = $('results');
    var items = checkedItems();
    var rest = excludedItems();

    box.hidden = state.items.length === 0;
    $('result-count').textContent = String(filledItems().length);
    $('result-region').textContent = region().label;
    list.innerHTML = items.map(cardHtml).join('');

    $('excluded').hidden = rest.length === 0;
    $('excluded-count').textContent = String(rest.length);
    excludedBox.innerHTML = rest.map(excludedHtml).join('');

    $('copy-names').disabled = filledItems().length === 0;
    $('copy-links').disabled = filledItems().length === 0;
    $('clear-all').disabled = state.items.length === 0;
    $('add-place').disabled = state.items.length >= MAX_ITEMS;
    $('merge-start').disabled = state.mergeMode || filledItems().length < 2;

    /* 합치기 모드: 남아 있는 선택만 유지하고 막대를 갱신 */
    if (state.mergeMode) {
      var alive = {};
      items.forEach(function (it) { if (state.mergeSel[it.id]) alive[it.id] = true; });
      state.mergeSel = alive;
      $('merge-bar').hidden = false;
      document.body.classList.add('merge-open');
      $('result-hint').textContent = '합칠 줄을 체크하고 아래 [합치기]를 누르세요. 이름은 자동으로 붙여집니다.';
      updateMergeBar();
    } else {
      $('merge-bar').hidden = true;
      document.body.classList.remove('merge-open');
      $('result-hint').textContent = '가게 이름을 눌러 바로 고칠 수 있어요. 고치면 링크도 같이 바뀌어요.';
    }
  }

  /* ---------------- 선택한 줄 합치기 ---------------- */

  function mergePicked() {
    return state.items.filter(function (it) { return it.checked && state.mergeSel[it.id]; });
  }

  function updateMergeBar() {
    var picked = mergePicked();
    var names = picked.map(function (it) { return it.name; })
      .filter(function (n) { return String(n || '').trim(); });
    $('merge-count').textContent = String(picked.length);
    $('merge-preview').textContent = names.length >= 2
      ? P.mergeNames(names)
      : '합칠 줄을 2개 이상 체크하세요';
    $('merge-apply').disabled = names.length < 2;
  }

  function startMerge() {
    if (filledItems().length < 2) {
      toast('합칠 항목이 2개 이상 있어야 해요');
      return;
    }
    state.mergeMode = true;
    state.mergeSel = {};
    renderResults();
  }

  function endMerge(silent) {
    state.mergeMode = false;
    state.mergeSel = {};
    renderResults();
    if (!silent) toast('합치기를 취소했어요');
  }

  function applyMerge() {
    var picked = mergePicked();
    var names = picked.map(function (it) { return it.name; })
      .filter(function (n) { return String(n || '').trim(); });
    if (names.length < 2) {
      toast('합칠 줄을 2개 이상 체크해 주세요');
      return;
    }

    var ids = picked.map(function (it) { return it.id; });
    var firstIndex = state.items.indexOf(picked[0]);
    var note = '';
    for (var i = 0; i < picked.length; i += 1) {
      if (picked[i].note) { note = picked[i].note; break; }
    }

    var merged = {
      id: uid(),
      name: P.mergeNames(names),
      checked: true,
      note: note,
      reason: '',
      source: 'merge'
    };

    state.items = state.items.filter(function (it) { return ids.indexOf(it.id) === -1; });
    if (firstIndex < 0 || firstIndex > state.items.length) firstIndex = state.items.length;
    state.items.splice(firstIndex, 0, merged);

    var count = names.length;
    state.mergeMode = false;
    state.mergeSel = {};
    renderResults();

    var card = document.querySelector('.place[data-id="' + merged.id + '"]');
    if (card) {
      scrollInto(card, { block: 'center' });
      var input = card.querySelector('.place-name');
      if (input) {
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* 무시 */ }
      }
    }
    toast(count + '줄을 하나로 합쳤어요');
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  function syncLinks(card, name) {
    var mapLink = card.querySelector('.act-map');
    var tabLink = card.querySelector('.act-tabelog');
    if (mapLink) mapLink.href = P.googleMapsUrl(name, state.regionId);
    if (tabLink) tabLink.href = P.tabelogUrl(name, state.regionId);
  }

  /* ---------------- 복사 ---------------- */

  function formatNames() {
    return filledItems().map(function (it, i) {
      return (i + 1) + '. ' + it.name;
    }).join('\n');
  }

  function formatWithLinks() {
    var r = region();
    var head = '📍 ' + r.label + ' 맛집 리스트';
    var body = filledItems().map(function (it, i) {
      return (i + 1) + '. ' + it.name + '\n   ' + P.googleMapsUrl(it.name, state.regionId);
    }).join('\n');
    return head + '\n\n' + body;
  }

  function doCopy(text, okMsg) {
    if (!text) { toast('복사할 항목이 없어요'); return; }
    copyText(text).then(function (ok) {
      toast(ok ? okMsg : '복사가 안 됐어요. 이름을 길게 눌러 직접 복사해 주세요');
    });
  }

  /* ---------------- 이벤트 ---------------- */

  function bindEvents() {
    /* 탭 */
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.addEventListener('click', function () { setTab(tab.getAttribute('data-tab')); });
    });

    /* 지역 */
    $('region-chips').addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.chip') : null;
      if (!chip) return;
      setRegion(chip.getAttribute('data-region'));
    });

    /* 사진 선택 */
    $('file-input').addEventListener('change', function (e) {
      addPhotos(e.target.files);
      e.target.value = '';
    });

    var dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (type) {
      dz.addEventListener(type, function (e) {
        e.preventDefault();
        dz.classList.add('is-drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      dz.addEventListener(type, function (e) {
        e.preventDefault();
        dz.classList.remove('is-drag');
      });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addPhotos(e.dataTransfer.files);
    });

    $('thumbs').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act="remove-photo"]') : null;
      if (!btn) return;
      var fig = btn.closest('[data-photo]');
      if (fig) removePhoto(fig.getAttribute('data-photo'));
    });

    $('run-ocr').addEventListener('click', runRecognition);

    var badgeClose = $('engine-badge-close');
    if (badgeClose) badgeClose.addEventListener('click', function () { hideEngineBadge(); });

    /* 한도·연결 때문에 OCR로 넘어간 뒤, 사용자가 원하면 AI로 다시 시도 */
    var badgeRetry = $('engine-badge-retry');
    if (badgeRetry) {
      badgeRetry.addEventListener('click', function () {
        state.visionOff = false;
        hideEngineBadge();
        toast('다음 사진부터 AI 인식으로 다시 시도할게요');
      });
    }
    $('clear-photos').addEventListener('click', function () {
      if (state.busy) { toast('인식 중에는 비울 수 없어요'); return; }
      clearPhotos();
    });

    /* 텍스트 */
    $('parse-text').addEventListener('click', function () {
      var text = $('paste-input').value;
      if (!text.trim()) { toast('붙여넣은 내용이 없어요'); return; }
      var before = state.items.length;
      ingestText(text, 'text');
      if (state.items.length === before) {
        toast('이미 담긴 목록이에요');
        return;
      }
      renderResults();
      scrollToResults();
    });

    $('paste-clipboard').addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        toast('이 브라우저에서는 입력창을 길게 눌러 붙여넣어 주세요');
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        if (!text) { toast('클립보드가 비어 있어요'); return; }
        $('paste-input').value = text;
        toast('클립보드에서 가져왔어요');
      }).catch(function () {
        toast('입력창을 길게 눌러 붙여넣어 주세요');
      });
    });

    /* 예시 */
    $('sample-btn').addEventListener('click', function () {
      setTab('text');
      $('paste-input').value = SAMPLE;
      var before = state.items.length;
      ingestText(SAMPLE, 'sample');
      renderResults();
      if (state.items.length === before) {
        toast('이미 예시가 담겨 있어요');
        return;
      }
      $('paste-input').value = SAMPLE;
      scrollToResults();
      toast('예시로 4곳을 담았어요. 📍 버튼을 눌러 보세요');
    });

    /* 결과 조작 */
    $('results').addEventListener('change', function (e) {
      var target = e.target;
      if (!target || target.type !== 'checkbox') return;
      var act = target.getAttribute('data-act');
      var host = target.closest ? target.closest('[data-id]') : null;
      if (!host) return;
      var item = findItem(host.getAttribute('data-id'));
      if (!item) return;
      if (act === 'merge-pick') {
        if (target.checked) state.mergeSel[item.id] = true;
        else delete state.mergeSel[item.id];
        host.classList.toggle('is-picked', !!target.checked);
        updateMergeBar();
      } else if (act === 'toggle') {
        item.checked = false;
        renderResults();
      } else if (act === 'restore') {
        item.checked = true;
        renderResults();
        toast('결과에 올렸어요');
      }
    });

    $('results').addEventListener('input', function (e) {
      var target = e.target;
      if (!target || target.getAttribute('data-act') !== 'rename') return;
      var host = target.closest ? target.closest('[data-id]') : null;
      if (!host) return;
      var item = findItem(host.getAttribute('data-id'));
      if (!item) return;
      item.name = target.value;
      syncLinks(host, target.value);
    });

    $('results').addEventListener('click', function (e) {
      var target = e.target;
      if (!target || target.type === 'checkbox') return;
      var btn = target.closest ? target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');

      var host = btn.closest('[data-id]');
      if (!host) return;
      var item = findItem(host.getAttribute('data-id'));
      if (!item) return;

      if (act === 'remove') {
        state.items = state.items.filter(function (it) { return it.id !== item.id; });
        renderResults();
      } else if (act === 'copy') {
        doCopy(item.name, '이름을 복사했어요 · ' + item.name);
      } else if (act === 'restore') {
        item.checked = true;
        renderResults();
        toast('결과에 올렸어요');
      }
    });

    $('add-place').addEventListener('click', function () {
      if (state.items.length >= MAX_ITEMS) return;
      var item = { id: uid(), name: '', checked: true, note: '', reason: '', source: 'manual' };
      state.items.push(item);
      renderResults();
      var input = document.querySelector('.place[data-id="' + item.id + '"] .place-name');
      if (input) {
        scrollInto(input, { block: 'center' });
        input.focus();
      }
    });

    $('merge-start').addEventListener('click', startMerge);
    $('merge-cancel').addEventListener('click', function () { endMerge(); });
    $('merge-apply').addEventListener('click', applyMerge);

    $('copy-names').addEventListener('click', function () {
      doCopy(formatNames(), filledItems().length + '곳 이름을 복사했어요');
    });

    $('copy-links').addEventListener('click', function () {
      doCopy(formatWithLinks(), filledItems().length + '곳 링크까지 복사했어요');
    });

    $('clear-all').addEventListener('click', function () {
      if (!state.items.length) return;
      state.items = [];
      renderResults();
      toast('목록을 비웠어요');
    });
  }

  /* ---------------- 시작 ---------------- */

  var inited = false;

  function init() {
    if (inited) return;
    inited = true;
    renderRegions();
    renderResults();
    setTab('photo');
    bindEvents();
    $('run-ocr').disabled = true;
    $('clear-photos').disabled = true;
    hideEngineBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
