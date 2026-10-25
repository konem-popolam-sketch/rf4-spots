/* Точки клёва RF4 — вся логика страницы.
   Без сборщика, без сервера, без внешних библиотек: чистый DOM API.
   Загрузка данных: (1) относительный путь ../data/*.json, (2) встроенный снимок
   site/data/*.js (нужен для file://), (3) ручной выбор файлов пользователем. */
'use strict';

(function () {
  // ---------- константы и состояние ----------

  var PAGE_SIZE = 96;
  var LEVEL_MIN = 1;
  var LEVEL_MAX = 34;

  var CONFIDENCE_RU = { high: 'высокая', medium: 'средняя', low: 'низкая' };
  var CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };
  // Порядок вывода: чем чаще способ ловли, тем выше в списке.
  var METHOD_ORDER = ['bottom', 'spinning', 'float', 'marine', 'carp', 'fly', 'ice'];

  var data = { meta: null, waterbodies: [], skills: [], spots: [] };
  var byId = { waterbody: new Map(), skill: new Map(), skillAlias: new Map() };
  var derived = { unknownSkill: 0, knownSkill: 0, uniqueFish: 0, perWaterbody: new Map() };

  var state = {
    level: LEVEL_MAX,
    waterbody: '',
    fish: '',
    method: '',
    skills: new Set(),
    strictSkill: false,
    square: '',
    confidence: 'any',
    sort: 'level',
    shown: PAGE_SIZE,
  };

  var el = {}; // ссылки на узлы страницы
  var filtered = []; // текущая выдача после фильтров и сортировки

  // ---------- утилиты ----------

  function byId_(id) { return document.getElementById(id); }

  function node(tag, props, children) {
    var n = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c == null || c === false) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }

  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  // Тексты из данных иногда говорят о поле словами «null» (например, в примечании к навыку).
  // На странице такого слова быть не должно — заменяем на человеческое «значение не задано».
  function deNull(s) {
    return String(s == null ? '' : s).replace(/(^|[\s(«"—,;:])null(?=[\s)»".,;:!?—]|$)/g, '$1значение не задано');
  }

  // «35» → «35», «1.45» → «1,45» — в русской типографике десятичный разделитель запятая.
  function num(v, digits) {
    if (v == null || v === '') return '—';
    var d = digits == null ? 1 : digits;
    var s = Number(v).toFixed(d);
    s = s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    return s.replace('.', ',');
  }

  // «2026-07-11T14:13» → «11.07.2026, 14:13»; дата без времени — как есть.
  function dateRu(iso) {
    if (!iso) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso));
    if (!m) return String(iso);
    var d = m[3] + '.' + m[2] + '.' + m[1];
    return m[4] ? d + ', ' + m[4] + ':' + m[5] : d;
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100;
    var b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function points(n) { return n + ' ' + plural(n, 'точка', 'точки', 'точек'); }

  // ---------- загрузка данных ----------

  function loadEmbedded() {
    if (Array.isArray(window.RF4_SPOTS) && window.RF4_SITE_DATA) {
      return {
        spots: window.RF4_SPOTS,
        waterbodies: window.RF4_SITE_DATA.waterbodies,
        skills: window.RF4_SITE_DATA.skills,
        meta: window.RF4_SITE_DATA.dataset,
      };
    }
    return null;
  }

  async function loadFromJsonAt(base) {
    var names = ['dataset.json', 'waterbodies.json', 'skills.json', 'spots.json'];
    var raw = await Promise.all(
      names.map(function (name) {
        return fetch(base + name, { cache: 'no-cache' }).then(function (r) {
          if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
          return r.json();
        });
      })
    );
    return { meta: raw[0], waterbodies: raw[1], skills: raw[2], spots: raw[3] };
  }

  // Куда смотреть за JSON. Порядок важен:
  //   ../data/ — страница лежит в site/ внутри проекта (file://, локальный сервер из корня);
  //   data/    — папка site/ опубликована как корень сайта (GitHub Pages, Netlify Drop).
  var JSON_BASES = ['../data/', 'data/'];

  async function loadFromJson() {
    var lastError = null;
    for (var i = 0; i < JSON_BASES.length; i++) {
      try {
        var payload = await loadFromJsonAt(JSON_BASES[i]);
        if (payload && Array.isArray(payload.spots) && payload.spots.length) return payload;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    throw new Error('Ни один путь к data/*.json не отдал данных.');
  }

  async function loadData() {
    // 1. Относительный путь к data/*.json — основной способ (работает на любом статическом хостинге).
    try {
      var fromJson = await loadFromJson();
      if (fromJson && Array.isArray(fromJson.spots) && fromJson.spots.length) {
        return { payload: fromJson, source: 'data/*.json' };
      }
    } catch (e) {
      // 2. По file:// браузер запрещает чтение файлов — берём встроенный снимок тех же данных.
      var embedded = loadEmbedded();
      if (embedded) return { payload: embedded, source: 'site/data/*.js' };
      throw e;
    }
    var again = loadEmbedded();
    if (again) return { payload: again, source: 'site/data/*.js' };
    throw new Error('Данные не найдены ни по пути ../data/*.json или data/*.json, ни во встроенном снимке site/data/*.js.');
  }

  // ---------- подготовка ----------

  function prepare(payload) {
    data.meta = payload.meta || {};
    data.waterbodies = (payload.waterbodies || []).slice();
    data.skills = (payload.skills || []).slice();
    data.spots = payload.spots || [];

    data.waterbodies.sort(function (a, b) {
      return a.level_min - b.level_min || String(a.name_ru).localeCompare(String(b.name_ru), 'ru');
    });

    byId.waterbody = new Map(data.waterbodies.map(function (w) { return [w.id, w]; }));
    byId.skill = new Map(data.skills.map(function (s) { return [s.id, s]; }));
    // Точки хранят в skill_req те же id, что и skills[].id; отдельный алиас не нужен,
    // но неизвестный id должен честно отображаться, а не теряться.
    byId.skillAlias = new Map(byId.skill);

    derived.perWaterbody = new Map();
    derived.squares = new Set();
    var fish = new Set();
    var unknown = 0;
    for (var i = 0; i < data.spots.length; i++) {
      var s = data.spots[i];
      var wb = byId.waterbody.get(s.waterbody_id);
      s._wbName = wb ? wb.name_ru : s.waterbody_id;
      s._wbLevel = wb ? wb.level_min : s.level_min;
      s._fishKey = norm(s.fish);
      s._square = s.square ? String(s.square).toUpperCase() : '';
      if (s._square) derived.squares.add(s._square);
      s._coord = s.x + ':' + s.y;
      s._skillIds = Array.isArray(s.skill_req) ? s.skill_req.slice() : [];
      // skill_req: [] — это «навык не определён», а не «навыки не нужны». Флаг нужен везде в UI.
      s._skillUnknown = s._skillIds.length === 0;
      if (s._skillUnknown) unknown++; else derived.knownSkill++;
      fish.add(s._fishKey);
      derived.perWaterbody.set(s.waterbody_id, (derived.perWaterbody.get(s.waterbody_id) || 0) + 1);
    }
    derived.unknownSkill = unknown;
    derived.uniqueFish = fish.size;

    // Водоёмы перечисляют 252 вида, но точки есть не у всех: разницу показываем честно, а не прячем.
    var speciesAll = new Set();
    data.waterbodies.forEach(function (w) {
      (w.species_ids || []).forEach(function (id) { speciesAll.add(id); });
    });
    derived.speciesInWaterbodies = speciesAll.size;
  }

  // ---------- сборка элементов управления ----------

  function fillWaterbodySelect() {
    var sel = el.waterbody;
    clear(sel);
    sel.appendChild(node('option', { value: '', text: 'Все водоёмы (' + data.waterbodies.length + ')' }));
    data.waterbodies.forEach(function (w) {
      var count = derived.perWaterbody.get(w.id) || 0;
      sel.appendChild(
        node('option', {
          value: w.id,
          text: w.name_ru + ' · нужен ур. ' + w.level_min + ' · ' + points(count),
        })
      );
    });
  }

  function fillFishDatalist() {
    var list = byId_('fish-list');
    clear(list);
    var names = Array.from(new Set(data.spots.map(function (s) { return s.fish; }))).sort(function (a, b) {
      return String(a).localeCompare(String(b), 'ru');
    });
    names.forEach(function (name) { list.appendChild(node('option', { value: name })); });

    // Водоёмы перечисляют больше видов, чем встречается в точках: молчать об этом — значит врать цифрой.
    var hint = byId_('fish-hint');
    if (hint) {
      var extra = derived.speciesInWaterbodies - derived.uniqueFish;
      hint.textContent =
        'Поиск по части названия: «щук» найдёт щуку, «окун» — окуня. Пустое поле — все виды. ' +
        'В точках встречается ' + derived.uniqueFish + ' видов из ' + derived.speciesInWaterbodies + ', перечисленных у водоёмов' +
        (extra > 0 ? ': у ' + extra + ' видов пока нет ни одной точки, поэтому в подсказках их нет.' : '.');
    }
  }

  function fillMethodSelect() {
    var sel = el.method;
    clear(sel);
    var counts = new Map();
    data.spots.forEach(function (s) {
      if (!s.method) return;
      counts.set(s.method, (counts.get(s.method) || 0) + 1);
    });
    var ids = Array.from(counts.keys()).sort(function (a, b) {
      var ia = METHOD_ORDER.indexOf(a); var ib = METHOD_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    sel.appendChild(node('option', { value: '', text: 'Любой способ' }));
    ids.forEach(function (id) {
      var skill = byId.skill.get(id);
      var label = skill ? skill.name_ru : id;
      sel.appendChild(node('option', { value: id, text: label + ' (' + counts.get(id) + ')' }));
    });
    var known = data.spots.length - (data.spots.filter(function (s) { return !s.method; }).length);
    var hint = el.methodHint || byId_('method-hint');
    if (hint) {
      hint.textContent =
        'Способ известен у ' + known + ' из ' + data.spots.length +
        ' точек: rf4-map.ru его не публикует, а rf4intel.com — лишь у части. У остальных в источнике способа нет.';
    }
  }

  function fillSkillsFilter() {
    var box = el.skillsFilter;
    clear(box);
    var skills = data.skills.filter(function (s) { return s.affects_filter; });
    skills.sort(function (a, b) { return METHOD_ORDER.indexOf(a.id) - METHOD_ORDER.indexOf(b.id); });

    skills.forEach(function (skill) {
      var count = data.spots.filter(function (s) { return s._skillIds.indexOf(skill.id) >= 0; }).length;
      var cb = node('input', { type: 'checkbox', value: skill.id, id: 'sk-' + skill.id });
      cb.addEventListener('change', function () {
        if (cb.checked) state.skills.add(skill.id); else state.skills.delete(skill.id);
        state.shown = PAGE_SIZE;
        render();
      });
      var levelText = skill.min_level == null
        ? 'уровень не проверен'
        : (skill.min_level_kind === 'lower_bound' ? '≥ ' + skill.min_level + ' (нижняя граница)' : String(skill.min_level));

      box.appendChild(
        node('label', { class: 'check-row' }, [
          cb,
          node('span', { class: 'check-text' }, [
            node('span', { text: skill.name_ru }),
            node('span', { class: 'tag-mini', text: levelText + ' · ' + points(count) }),
          ]),
        ])
      );
    });

    var craftBox = byId_('craft-skills');
    if (craftBox) {
      clear(craftBox);
      data.skills
        .filter(function (s) { return !s.affects_filter; })
        .forEach(function (s) {
          craftBox.appendChild(
            node('li', {}, [
              node('span', { text: s.name_ru + ' — ' }),
              node('span', { class: 'tag-mini', text: s.min_level == null ? 'уровень не проверен' : String(s.min_level) }),
            ])
          );
        });
    }
  }

  function renderHeader() {
    var counts = data.meta.counts || {};
    byId_('stat-spots').textContent = String(data.spots.length);
    byId_('stat-wb').textContent = String(data.waterbodies.length);
    byId_('stat-fish').textContent = String(derived.uniqueFish);
    byId_('stat-high').textContent = String(counts.spots_high != null
      ? counts.spots_high
      : data.spots.filter(function (s) { return s.confidence === 'high'; }).length);
    byId_('stat-date').textContent = data.meta.updated_at ? dateRu(data.meta.updated_at) : '—';
    var lede = byId_('head-lede');
    if (lede) {
      lede.textContent =
        'Данные собраны из публичных постов игроков на rf4-map.ru и rf4intel.com, дата актуальности — ' +
        (data.meta.updated_at ? dateRu(data.meta.updated_at) : 'не указана') +
        '. У каждой точки — видимая ссылка на источник.';
    }
    var total = byId_('count-total');
    if (total) total.textContent = String(data.spots.length);
  }

  function renderFooter() {
    byId_('f-updated').textContent = data.meta.updated_at ? dateRu(data.meta.updated_at) : 'не указана';

    var counts = data.meta.counts || {};
    var countsText = [
      'Точек: ' + data.spots.length,
      'водоёмов: ' + data.waterbodies.length,
      'навыков в справочнике: ' + data.skills.length,
      'уверенность высокая: ' + (counts.spots_high != null ? counts.spots_high : '—'),
      'средняя: ' + (counts.spots_medium != null ? counts.spots_medium : '—'),
    ].join(' · ');
    byId_('f-counts').textContent = countsText;

    byId_('f-disclaimer').textContent = data.meta.disclaimer ||
      'Неофициальный фанатский справочник. Не связан с разработчиком игры.';

    var srcList = byId_('f-sources');
    clear(srcList);
    (data.meta.sources || []).forEach(function (src) {
      srcList.appendChild(
        node('li', {}, [
          node('a', { href: src.url, rel: 'noopener noreferrer', text: src.id || src.url }),
          node('span', { class: 'src-what', text: (src.what ? src.what + ' ' : '') + (src.license_note ? '(' + src.license_note + ')' : '') }),
        ])
      );
    });

    var info = byId_('skills-info');
    if (info) {
      clear(info);
      data.skills.forEach(function (s) {
        var lvl = s.min_level == null
          ? 'уровень не проверен'
          : (s.min_level_kind === 'lower_bound' ? '≥ ' + s.min_level + ' (только нижняя граница)' : 'уровень ' + s.min_level);
        info.appendChild(
          node('div', { class: 'skill-card' }, [
            node('h3', { text: s.name_ru }),
            node('p', { class: 'lvl', text: lvl }),
            node('p', { text: s.opens || '' }),
            node('p', { class: 'afl', text: s.affects_filter ? 'Влияет на доступность точки.' : 'Крафт: на доступность точек не влияет.' }),
            s.note ? node('p', { class: 'afl', text: deNull(s.note) }) : null,
            s.verify_url ? node('p', {}, [node('a', { href: s.verify_url, rel: 'noopener noreferrer', text: 'Где сверять уровень ↗' })]) : null,
          ])
        );
      });
    }
  }

  // ---------- фильтрация ----------

  function parseSquareQuery(raw) {
    var q = norm(raw).replace(/[.,;]/g, ' ');
    var coord = /^(\d{1,4})\s*[:\s]\s*(\d{1,4})$/.exec(q);
    if (coord) return { kind: 'coord', x: Number(coord[1]), y: Number(coord[2]) };
    var cyr = { 'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'н': 'h', 'к': 'k', 'м': 'm', 'о': 'o', 'р': 'p', 'т': 't', 'у': 'y', 'х': 'x' };
    var latin = q.replace(/[а-я]/g, function (ch) { return cyr[ch] || ch; }).replace(/\s+/g, '').toUpperCase();
    if (!latin) return null;
    return { kind: 'square', q: latin };
  }

  function matchesSquare(spot, query) {
    var q = parseSquareQuery(query);
    if (!q) return true;
    if (q.kind === 'coord') return spot.x === q.x && spot.y === q.y;
    // Точное имя квадрата важнее префикса: «A1» — это A1, а не A1 + A10.
    if (derived.squares.has(q.q)) return spot._square === q.q;
    return spot._square.indexOf(q.q) === 0;
  }

  function skillFilterActive() { return state.skills.size > 0; }

  function passesSkills(spot) {
    if (!skillFilterActive()) return true; // фильтр выключен, пока не отмечен ни один навык
    if (spot._skillUnknown) return !state.strictSkill; // неизвестный навык не скрываем без явного согласия
    for (var i = 0; i < spot._skillIds.length; i++) {
      if (!state.skills.has(spot._skillIds[i])) return false;
    }
    return true;
  }

  function computeFiltered() {
    var pool = data.spots;
    var hidden = { level: 0, waterbody: 0, fish: 0, method: 0, square: 0, confidence: 0, skills: 0 };

    var fishQuery = norm(state.fish);
    var list = pool.filter(function (s) {
      if (s.level_min > state.level) { hidden.level++; return false; }
      if (state.waterbody && s.waterbody_id !== state.waterbody) { hidden.waterbody++; return false; }
      if (fishQuery && s._fishKey.indexOf(fishQuery) < 0) { hidden.fish++; return false; }
      if (state.method && s.method !== state.method) { hidden.method++; return false; }
      if (state.square && !matchesSquare(s, state.square)) { hidden.square++; return false; }
      if (state.confidence === 'high' && s.confidence !== 'high') { hidden.confidence++; return false; }
      if (state.confidence === 'medium' && s.confidence === 'low') { hidden.confidence++; return false; }
      if (!passesSkills(s)) { hidden.skills++; return false; }
      return true;
    });

    return { list: sortSpots(list), hidden: hidden };
  }

  function sortSpots(list) {
    var cmp;
    switch (state.sort) {
      case 'waterbody':
        cmp = function (a, b) {
          return a._wbLevel - b._wbLevel ||
            String(a._wbName).localeCompare(String(b._wbName), 'ru') ||
            a.x - b.x || a.y - b.y || String(a.fish).localeCompare(String(b.fish), 'ru');
        };
        break;
      case 'fish':
        cmp = function (a, b) {
          return String(a.fish).localeCompare(String(b.fish), 'ru') || a._wbLevel - b._wbLevel;
        };
        break;
      case 'fresh':
        cmp = function (a, b) {
          return String(b.posted_at || '').localeCompare(String(a.posted_at || '')) || a._wbLevel - b._wbLevel;
        };
        break;
      case 'confidence':
        cmp = function (a, b) {
          return (CONFIDENCE_RANK[a.confidence] || 0) - (CONFIDENCE_RANK[b.confidence] || 0) ||
            a._wbLevel - b._wbLevel || String(a.fish).localeCompare(String(b.fish), 'ru');
        };
        break;
      default:
        cmp = function (a, b) {
          return a.level_min - b.level_min ||
            String(a._wbName).localeCompare(String(b._wbName), 'ru') ||
            String(a.fish).localeCompare(String(b.fish), 'ru');
        };
    }
    return list.slice().sort(cmp);
  }

  // ---------- карточка точки ----------

  function skillBadge(spot) {
    if (spot._skillUnknown) {
      return node('span', {
        class: 'badge badge-skill-unknown',
        title: 'В источнике не указан способ ловли, поэтому требуемый навык не определён. Точка не скрывается.',
        text: 'навык не проверен',
      });
    }
    var names = spot._skillIds.map(function (id) {
      var s = byId.skillAlias.get(id);
      return s ? s.name_ru : id;
    });
    return node('span', {
      class: 'badge badge-skill',
      title: 'Способ ловли взят из источника' + (spot.method_source === 'post-text' ? ' (по тексту поста, менее надёжно)' : '') + '.',
      text: 'навык: ' + names.join(', '),
    });
  }

  function confidenceBadge(spot) {
    var c = spot.confidence || 'low';
    return node('span', {
      class: 'badge badge-conf-' + c,
      title: 'Уверенность считается по числу подтверждённых параметров точки.',
      text: 'уверенность: ' + (CONFIDENCE_RU[c] || c),
    });
  }

  function buildCard(spot) {
    var facts = [];
    var missing = [];

    facts.push([node('dt', { text: 'Водоём' }), node('dd', {}, [
      node('span', { text: spot._wbName }),
      node('span', { class: 'meta', text: ' · ур. ' + spot._wbLevel + '+' }),
    ])]);
    facts.push([node('dt', { text: 'Квадрат' }), node('dd', { text: spot.square ? spot.square + ' · ' + spot._coord : spot._coord })]);

    if (spot.method) {
      var ms = byId.skill.get(spot.method);
      facts.push([node('dt', { text: 'Способ' }), node('dd', { text: (ms ? ms.name_ru : spot.method) })]);
    } else missing.push('способ ловли');

    if (spot.clip_m != null) facts.push([node('dt', { text: 'Клипса' }), node('dd', { text: num(spot.clip_m, 1) + ' м' })]);
    else missing.push('клипса');

    if (spot.depth_m != null) facts.push([node('dt', { text: 'Глубина' }), node('dd', { text: num(spot.depth_m, 2) + ' м' })]);
    else missing.push('глубина');

    if (spot.speed != null && spot.speed !== '') facts.push([node('dt', { text: 'Скорость' }), node('dd', { text: String(spot.speed) })]);
    else missing.push('скорость');

    if (spot.bait) facts.push([node('dt', { text: 'Наживка' }), node('dd', { text: String(spot.bait) })]);
    else missing.push('наживка');

    facts.push([node('dt', { text: 'Пост' }), node('dd', { text: dateRu(spot.posted_at) })]);

    var factList = [];
    facts.forEach(function (pair) { if (pair) factList.push(pair[0], pair[1]); });

    var tags = (spot.tags || []).length
      ? node('ul', { class: 'tags' }, spot.tags.map(function (t) { return node('li', { text: t }); }))
      : null;

    var links = [
      node('a', {
        class: 'src-link',
        href: spot.source_url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Страница точки на rf4-map.ru — откуда взяты координата, квадрат и параметры',
        text: 'Источник' + (hostOf(spot.source_url) ? ' (' + hostOf(spot.source_url) + ')' : ''),
      }),
    ];
    if (spot.original_url) {
      links.push(node('a', {
        class: 'src-link',
        href: spot.original_url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Оригинальный публичный пост игрока (атрибуция rf4intel.com)',
        text: 'Оригинальный пост',
      }));
    }
    if (spot.intel_url) {
      links.push(node('a', {
        class: 'src-link',
        href: spot.intel_url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Страница rf4intel.com с полями Method / Bait',
        text: 'rf4intel.com',
      }));
    }

    var card = node('li', { class: 'card' }, [
      node('div', { class: 'card-head' }, [
        node('h3', { class: 'card-fish', text: spot.fish }),
        node('span', { class: 'badge badge-level', title: 'Минимальный уровень игрока для доступа к водоёму', text: 'ур. ' + spot.level_min + '+' }),
        skillBadge(spot),
        confidenceBadge(spot),
      ]),
      node('dl', { class: 'facts' }, factList),
      tags,
      missing.length
        ? node('p', { class: 'card-missing', title: 'Поля не публикуются источником — это не ноль и не «не нужно»', text: 'Источник не сообщает: ' + missing.join(', ') + '.' })
        : node('p', { class: 'card-missing ok', text: 'Все параметры точки есть в источнике.' }),
      node('div', { class: 'card-foot' }, links.concat([
        node('span', { class: 'meta', text: 'проверено ' + dateRu(spot.checked_at) }),
      ])),
    ]);
    return card;
  }

  // ---------- отрисовка выдачи ----------

  function renderChips(hidden) {
    var box = el.chips;
    clear(box);
    var order = [
      ['level', 'уровень игрока ≤ ' + state.level, hidden.level],
      ['waterbody', 'водоём', hidden.waterbody],
      ['fish', 'рыба «' + state.fish + '»', hidden.fish],
      ['method', 'способ ловли', hidden.method],
      ['square', 'квадрат / координата', hidden.square],
      ['confidence', 'уверенность в данных', hidden.confidence],
      ['skills', 'навыки', hidden.skills],
    ];
    var any = false;
    order.forEach(function (row) {
      if (row[2] > 0) {
        any = true;
        box.appendChild(node('span', { class: 'chip' }, [
          node('span', { text: row[1] + ': ' }),
          node('b', { text: '−' + row[2] }),
        ]));
      }
    });
    box.hidden = !any;
  }

  function renderNotice() {
    var notice = el.notice;
    var strictHidden = state.strictSkill && skillFilterActive()
      ? data.spots.filter(function (s) { return s._skillUnknown; }).length
      : 0;
    if (strictHidden > 0) {
      notice.hidden = false;
      notice.className = 'notice';
      notice.textContent =
        'Включён строгий режим навыков: скрыто ' + points(strictHidden) +
        ' с непроверенным навыком. Это ваше решение — источник навык не сообщает, поэтому по умолчанию такие точки видны.';
    } else if (!skillFilterActive()) {
      notice.hidden = false;
      notice.className = 'notice ok';
      notice.textContent =
        'Фильтр по навыкам выключен: не отмечен ни один навык. Уровни открытия навыков не подтверждены ни одним разрешённым источником, поэтому точки с непроверенным навыком видны и помечены.';
    } else {
      notice.hidden = true;
      notice.textContent = '';
    }
  }

  function renderEmpty(hidden) {
    var empty = el.empty;
    if (filtered.length) { empty.hidden = true; return; }
    empty.hidden = false;

    var strong = empty.querySelector('.empty-why');
    var reasons = [];
    if (hidden.level > 0) {
      var locked = data.waterbodies.filter(function (w) { return w.level_min > state.level; });
      reasons.push(
        'уровень игрока ' + state.level + ' закрывает ' + points(hidden.level) + ' — ' +
        (locked.length
          ? 'из водоёмов недоступны: ' + locked.map(function (w) { return w.name_ru + ' (ур. ' + w.level_min + ')'; }).join(', ') + '.'
          : 'поднимите уровень, чтобы их увидеть.')
      );
    }
    if (hidden.waterbody > 0) reasons.push('выбран только один водоём — снимите фильтр «Водоём»');
    if (hidden.fish > 0) reasons.push('в названии рыбы ищется «' + state.fish + '» — очистите поле');
    if (hidden.method > 0) reasons.push('выбран конкретный способ ловли');
    if (hidden.square > 0) reasons.push('задан квадрат или координата');
    if (hidden.confidence > 0) reasons.push('включён фильтр уверенности');
    if (hidden.skills > 0) reasons.push('скрыты точки с неотмеченными навыками');

    if (strong) {
      strong.textContent = reasons.length
        ? 'Ни одна точка не прошла фильтры. Скрывает: ' + reasons.join('; ') + '.'
        : 'Ни одна точка не прошла фильтры.';
    }
  }

  function renderList() {
    var list = el.list;
    clear(list);
    var frag = document.createDocumentFragment();
    var slice = filtered.slice(0, state.shown);
    for (var i = 0; i < slice.length; i++) frag.appendChild(buildCard(slice[i]));
    list.appendChild(frag);

    el.more.hidden = filtered.length <= state.shown;
    el.shownNote.textContent = filtered.length
      ? 'Показано ' + slice.length + ' из ' + points(filtered.length) + '.'
      : '';
  }

  function render() {
    var result = computeFiltered();
    filtered = result.list;
    if (state.shown > filtered.length) state.shown = Math.max(PAGE_SIZE, filtered.length);
    byId_('count-shown').textContent = String(filtered.length);
    byId_('count-total').textContent = String(data.spots.length);
    renderChips(result.hidden);
    renderNotice();
    renderEmpty(result.hidden);
    renderList();

    var wbHint = byId_('wb-hint');
    if (wbHint) {
      var open = data.waterbodies.filter(function (w) { return w.level_min <= state.level; }).length;
      wbHint.textContent = 'При уровне ' + state.level + ' доступно ' + open + ' из ' + data.waterbodies.length + ' водоёмов.';
    }
    var levelHint = byId_('level-hint');
    if (levelHint) {
      var lockedNow = data.waterbodies.filter(function (w) { return w.level_min > state.level; });
      levelHint.textContent = lockedNow.length
        ? 'Закрыты: ' + lockedNow.map(function (w) { return w.name_ru + ' (' + w.level_min + ')'; }).join(', ') + '.'
        : 'Все водоёмы открыты.';
    }
    var note = byId_('skill-note');
    if (note) {
      note.textContent =
        'Навык не определён у ' + derived.unknownSkill + ' ' + plural(derived.unknownSkill, 'точки', 'точек', 'точек') +
        ' — они остаются в выдаче с пометкой «навык не проверен». Навык известен у ' + derived.knownSkill + '.';
    }
  }

  // ---------- события ----------

  function setLevel(value, fromInput) {
    var v = Number(value);
    if (!isFinite(v)) v = LEVEL_MAX;
    v = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.round(v)));
    state.level = v;
    if (!fromInput) el.levelRange.value = String(v);
    el.levelNum.value = String(v);
    state.shown = PAGE_SIZE;
    render();
  }

  function resetAll() {
    state.level = LEVEL_MAX;
    state.waterbody = '';
    state.fish = '';
    state.method = '';
    state.skills.clear();
    state.strictSkill = false;
    state.square = '';
    state.confidence = 'any';
    state.sort = 'level';
    state.shown = PAGE_SIZE;

    el.levelRange.value = String(LEVEL_MAX);
    el.levelNum.value = String(LEVEL_MAX);
    el.waterbody.value = '';
    el.fish.value = '';
    el.method.value = '';
    el.square.value = '';
    el.confidence.value = 'any';
    el.sort.value = 'level';
    el.strictSkill.checked = false;
    var boxes = el.skillsFilter.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
    render();
  }

  function bindEvents() {
    el.waterbody.addEventListener('change', function () {
      state.waterbody = el.waterbody.value; state.shown = PAGE_SIZE; render();
    });
    el.levelRange.addEventListener('input', function () { setLevel(el.levelRange.value, true); });
    el.levelNum.addEventListener('change', function () { setLevel(el.levelNum.value, false); });
    el.fish.addEventListener('input', function () {
      state.fish = el.fish.value; state.shown = PAGE_SIZE; render();
    });
    el.method.addEventListener('change', function () {
      state.method = el.method.value; state.shown = PAGE_SIZE; render();
    });
    el.square.addEventListener('input', function () {
      state.square = el.square.value; state.shown = PAGE_SIZE; render();
    });
    el.confidence.addEventListener('change', function () {
      state.confidence = el.confidence.value; state.shown = PAGE_SIZE; render();
    });
    el.sort.addEventListener('change', function () {
      state.sort = el.sort.value; state.shown = PAGE_SIZE; render();
    });
    el.strictSkill.addEventListener('change', function () {
      state.strictSkill = el.strictSkill.checked; state.shown = PAGE_SIZE; render();
    });
    el.btnReset.addEventListener('click', resetAll);
    var btnReset2 = byId_('btn-reset-2');
    if (btnReset2) btnReset2.addEventListener('click', resetAll);
    el.more.addEventListener('click', function () {
      state.shown += PAGE_SIZE;
      renderList();
      byId_('count-shown').textContent = String(filtered.length);
    });

    var all = byId_('skills-all');
    var none = byId_('skills-none');
    if (all) all.addEventListener('click', function () {
      state.skills.clear();
      data.skills.forEach(function (s) { if (s.affects_filter) state.skills.add(s.id); });
      var boxes = el.skillsFilter.querySelectorAll('input[type="checkbox"]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = true;
      state.shown = PAGE_SIZE;
      render();
    });
    if (none) none.addEventListener('click', function () {
      state.skills.clear();
      var boxes = el.skillsFilter.querySelectorAll('input[type="checkbox"]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
      state.shown = PAGE_SIZE;
      render();
    });

    var toggle = el.toggle;
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        el.filters.hidden = open;
      });
    }

    // Ручная загрузка JSON, если ни один автоматический путь не сработал.
    var fileInput = byId_('file-input');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var files = Array.from(fileInput.files || []);
        if (!files.length) return;
        var status = byId_('file-status');
        var slots = {};
        var pending = files.map(function (f) {
          return f.text().then(function (text) { slots[f.name] = JSON.parse(text); });
        });
        Promise.all(pending)
          .then(function () {
            var payload = {
              meta: slots['dataset.json'] || slots['data/dataset.json'],
              waterbodies: slots['waterbodies.json'] || slots['data/waterbodies.json'],
              skills: slots['skills.json'] || slots['data/skills.json'],
              spots: slots['spots.json'] || slots['data/spots.json'],
            };
            if (!payload.spots || !payload.waterbodies || !payload.skills) {
              throw new Error('Нужны четыре файла: dataset.json, waterbodies.json, skills.json, spots.json.');
            }
            payload.meta = payload.meta || {};
            boot(payload, 'файлы, выбранные вручную');
            if (status) status.textContent = 'Данные загружены: ' + payload.spots.length + ' точек.';
          })
          .catch(function (err) {
            if (status) status.textContent = 'Не удалось прочитать файлы: ' + (err && err.message ? err.message : err);
          });
      });
    }
  }

  function collapseFiltersOnMobile() {
    if (!window.matchMedia || !window.matchMedia('(max-width: 860px)').matches) return;
    if (el.toggle && el.filters) {
      el.toggle.setAttribute('aria-expanded', 'false');
      el.filters.hidden = true;
    }
  }

  function cacheNodes() {
    el.waterbody = byId_('f-waterbody');
    el.levelRange = byId_('f-level');
    el.levelNum = byId_('f-level-num');
    el.fish = byId_('f-fish');
    el.method = byId_('f-method');
    el.skillsFilter = byId_('skills-filter');
    el.strictSkill = byId_('f-skill-strict');
    el.square = byId_('f-square');
    el.confidence = byId_('f-confidence');
    el.sort = byId_('f-sort');
    el.btnReset = byId_('btn-reset');
    el.toggle = byId_('filters-toggle');
    el.filters = byId_('filters');
    el.chips = byId_('hidden-chips');
    el.notice = byId_('notice');
    el.empty = byId_('empty-state');
    el.list = byId_('list');
    el.more = byId_('btn-more');
    el.shownNote = byId_('shown-note');
    el.methodHint = null; // подсказка про способ берётся из разметки; обновляется ниже
  }

  function boot(payload, sourceLabel) {
    var err = byId_('load-error');
    if (err) err.hidden = true;
    var main = byId_('main');
    if (main) main.hidden = false;

    prepare(payload);
    cacheNodes();
    fillWaterbodySelect();
    fillFishDatalist();
    fillMethodSelect();
    fillSkillsFilter();
    renderHeader();
    renderFooter();
    bindEvents();
    collapseFiltersOnMobile();
    render();

    document.body.setAttribute('data-loaded', '1');
    if (sourceLabel) document.body.setAttribute('data-source', sourceLabel);
  }

  function showLoadError(message) {
    var box = byId_('load-error');
    var msg = byId_('load-error-msg');
    if (box) box.hidden = false;
    if (msg) {
      msg.textContent = message + (location.protocol === 'file:'
        ? ' Страница открыта по file://, и браузер запрещает чтение JSON с диска: используйте встроенный снимок site/data/*.js или выберите файлы вручную ниже.'
        : '');
    }
    var main = byId_('main');
    if (main) main.hidden = true;
  }

  async function start() {
    try {
      var loaded = await loadData();
      boot(loaded.payload, loaded.source);
    } catch (e) {
      showLoadError('Данные не загрузились: ' + (e && e.message ? e.message : String(e)) + '.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
