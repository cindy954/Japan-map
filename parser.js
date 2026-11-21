/*!
 * parser.js — 일본어 가게명 추출 + 구글맵/타베로그 링크 생성
 * DOM 없이도 동작하도록 분리했어요. (node에서 그대로 테스트 가능)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FoodParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 지역별 검색 보정값
     - ja: 구글맵 검색어 뒤에 붙는 지역명
     - tabelog: 타베로그 지역 경로 (없으면 전국 검색) */
  var REGIONS = [
    { id: 'all', label: '일본 전체', ja: '', tabelog: '' },
    { id: 'osaka', label: '오사카', ja: '大阪', tabelog: 'osaka' },
    { id: 'tokyo', label: '도쿄', ja: '東京', tabelog: 'tokyo' },
    { id: 'nagoya', label: '나고야', ja: '名古屋', tabelog: 'aichi' },
    { id: 'fukuoka', label: '후쿠오카', ja: '福岡', tabelog: 'fukuoka' },
    { id: 'kyoto', label: '교토', ja: '京都', tabelog: 'kyoto' },
    { id: 'sapporo', label: '삿포로', ja: '札幌', tabelog: 'hokkaido' }
  ];

  var JP_CHAR = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
  var JP_CHAR_G = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/g;
  var HANGUL_G = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/g;

  /* 줄 맨 앞의 번호·불릿·이모지 */
  var LEAD_RE = new RegExp(
    '^(?:' +
      '[\\s\\u3000]+' +
      '|[-–—•·*#>~|:：,、]+' +
      '|\\d{1,2}\\s*[.)]\\s*' +
      '|\\(?\\d{1,2}\\)' +
      '|[\\u2460-\\u2473\\u2488-\\u249b\\u24ea]' +
      '|[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{21FF}\\u{2300}-\\u{23FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\uFE0F\\u200D]' +
    ')',
    'u'
  );
  var PICTO_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/gu;

  /* 노이즈 판정 규칙 (위에서부터 먼저 걸리는 것 적용) */
  var NOISE_RULES = [
    { reason: '링크', test: function (t) { return /https?:\/\/|www\./i.test(t); } },
    { reason: '해시태그', test: function (t) { return /^#/.test(t) && !JP_CHAR.test(t); } },
    { reason: '계정 태그', test: function (t) { return /^@[\w._]{2,}$/.test(t); } },
    {
      reason: '시간·가격',
      test: function (t) {
        return /(?:¥|￥)\s?\d/.test(t) ||
          /\d{1,3}(?:,\d{3})+\s*(?:원|엔|円)/.test(t) ||
          /\d{1,2}\s*:\s*\d{2}/.test(t) ||
          /\d\s*(?:엔|円|원)(?:\s|$|~|-)/.test(t);
      }
    },
    { reason: '전화번호', test: function (t) { return /^\+?\d[\d\s()-]{7,}$/.test(t); } },
    { reason: '숫자만', test: function (t) { return /^[\d\s.,%+\-~★☆●○·]+$/.test(t); } },
    { reason: '평점', test: function (t) { return /^★?\s*\d(?:\.\d)?\s*(?:★|☆|\/5|점)?$/.test(t); } }
  ];

  function getRegion(id) {
    for (var i = 0; i < REGIONS.length; i++) {
      if (REGIONS[i].id === id) return REGIONS[i];
    }
    return REGIONS[0];
  }

  function hasJapanese(text) {
    return JP_CHAR.test(String(text || ''));
  }

  /* 줄 하나 정리: 앞 번호/불릿/이모지, 특수문자, 중복 공백 제거 */
  function cleanLine(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/[\u200b\u200c\u200d\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    var prev = null;
    var guard = 0;
    while (prev !== s && guard < 12) {
      prev = s;
      s = s.replace(LEAD_RE, '');
      guard += 1;
    }
    s = s.replace(/^[\s:：,、·|]+/, '').replace(/[\s:：,、·|]+$/, '');
    s = s.replace(PICTO_RE, '').replace(/\s+/g, ' ').trim();
    return s;
  }

  /* 이름 끝에 붙은 전화번호·해시태그·괄호 찌꺼기 제거 */
  function stripNoiseTail(s) {
    return String(s)
      .replace(/(?:\s*#\S+)+$/g, '')
      .replace(/\s*(?:TEL|Tel|tel|전화|☎)\s*[:：]?\s*[\d\-\s]{6,}/g, '')
      .replace(/\s*\+?\d{2,4}[-\s]?\d{2,4}[-\s]?\d{3,4}\s*$/g, '')
      .replace(/\s*[（(]\s*[)）]\s*$/g, '')
      .replace(/[\s,、·|]+$/g, '')
      .trim();
  }

  /* 한 줄 판정: 후보(candidate)인지 노이즈(noise)인지 */
  function analyze(raw) {
    var name = cleanLine(raw);
    if (!name) return { kind: 'empty', name: '', reason: '' };
    if (name.length < 2) return { kind: 'noise', name: name, reason: '너무 짧음' };

    for (var i = 0; i < NOISE_RULES.length; i += 1) {
      if (NOISE_RULES[i].test(name)) {
        return { kind: 'noise', name: name, reason: NOISE_RULES[i].reason };
      }
    }

    var jp = (name.match(JP_CHAR_G) || []).length;
    var ko = (name.match(HANGUL_G) || []).length;

    if (jp === 0) return { kind: 'noise', name: name, reason: ko ? '한국어만' : '일본어 없음' };
    /* 한국어 문장 속에 일본어 단어가 하나 섞인 경우 */
    if (ko > jp * 3 && name.length > 12) return { kind: 'noise', name: name, reason: '한국어 설명' };
    if (name.length > 48) return { kind: 'noise', name: name, reason: '설명문' };
    if (ko > 0 && jp < 2 && name.length > 16) return { kind: 'noise', name: name, reason: '한국어 설명' };

    var cleaned = stripNoiseTail(name) || name;
    return { kind: 'candidate', name: cleaned, reason: '' };
  }

  /* 한 줄을 여러 항목으로 나눌지 결정
     - 링크가 들어있으면 나누지 않음
     - 쉼표/가운뎃점으로 나뉜 조각이 전부 일본어면 목록으로 보고 나눔
     - 섞여 있으면 문장으로 보고 그대로 둠 */
  function splitParts(line) {
    var text = String(line || '');
    if (/https?:\/\/|www\./i.test(text)) return [text];
    var sep = /\s*[|•·、,，]\s*|\s+\/\s+/;
    if (!sep.test(text)) return [text];
    var parts = text.split(sep).map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length < 2) return [text];
    for (var i = 0; i < parts.length; i += 1) {
      if (!JP_CHAR.test(parts[i])) return [text];
    }
    return parts;
  }

  function dedupeKey(name) {    return String(name || '')
      .toLowerCase()
      .replace(/[\s\u3000\-–—_.,、。·|'"“”()（）「」『』\[\]{}]/g, '');
  }

  /* 번호·불릿·이모지로 시작하면 목록의 한 줄로 보고 설명으로 삼키지 않음 */
  function looksLikeListItem(line) {
    return /^\s*(?:\d{1,2}\s*[.)]|[-–—•·*#>]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])/u.test(String(line || ''));
  }

  /**
   * 붙여넣은 텍스트(또는 OCR 결과)를 목록으로 변환
   * 반환: [{ name, checked, note, reason }]
   *  - checked=true  → 결과 후보
   *  - checked=false → 노이즈(제외 목록에서 다시 켤 수 있음)
   */
  function parseText(input) {
    var text = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
    var chunks = [];
    text.split('\n').forEach(function (line) {
      splitParts(line).forEach(function (part) {
        if (part.trim()) chunks.push(part);
      });
    });

    var items = [];
    var seen = Object.create(null);

    for (var i = 0; i < chunks.length; i += 1) {
      var res = analyze(chunks[i]);
      if (res.kind === 'empty') continue;

      if (res.kind === 'candidate') {
        var key = dedupeKey(res.name);
        if (!key || seen[key]) continue;
        seen[key] = true;

        /* 바로 다음 줄이 한국어 설명이면 메모로 붙임 */
        var note = '';
        var next = chunks[i + 1];
        if (next && !looksLikeListItem(next)) {
          var nr = analyze(next);
          if (nr.kind === 'noise' && (nr.reason === '한국어만' || nr.reason === '한국어 설명')) {
            note = nr.name.slice(0, 90);
            i += 1;
          }
        }
        items.push({ name: res.name, checked: true, note: note, reason: '' });
      } else {
        var nkey = dedupeKey(res.name) + '|' + res.reason;
        if (nkey && seen[nkey]) continue;
        if (nkey) seen[nkey] = true;
        items.push({ name: res.name, checked: false, note: '', reason: res.reason });
      }
    }
    return items;
  }

  /* 타베로그 검색어로 쓸 일본어 부분만 뽑기 */
  function japaneseQuery(name) {
    var parts = String(name || '').split(/[\s\u3000、,，。・/|()（）「」『』\[\]{}<>:：;；!！?？〜~…"'“”]+/);
    var ja = parts.filter(function (p) { return JP_CHAR.test(p); });
    var q = ja.join(' ').trim() || String(name || '').trim();
    return q.slice(0, 60);
  }

  function googleMapsUrl(name, regionId) {
    var region = getRegion(regionId);
    var q = [String(name || '').trim(), region.ja].filter(Boolean).join(' ');
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  }

  function tabelogUrl(name, regionId) {
    var region = getRegion(regionId);
    var sw = encodeURIComponent(japaneseQuery(name));
    return 'https://tabelog.com/' + (region.tabelog ? region.tabelog + '/' : '') + 'rstLst/?sw=' + sw;
  }

  return {
    REGIONS: REGIONS,
    getRegion: getRegion,
    hasJapanese: hasJapanese,
    cleanLine: cleanLine,
    analyze: analyze,
    splitParts: splitParts,
    parseText: parseText,
    dedupeKey: dedupeKey,
    japaneseQuery: japaneseQuery,
    looksLikeListItem: looksLikeListItem,
    googleMapsUrl: googleMapsUrl,
    tabelogUrl: tabelogUrl
  };
});
