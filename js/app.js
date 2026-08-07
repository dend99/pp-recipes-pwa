/* ============================================================================
 * app.js — Логика PWA «ПП Рецепты».
 * Хранение — localStorage (полностью оффлайн). Без фреймворков.
 * ==========================================================================*/
'use strict';

const MEALS = {
  breakfast: { label: 'Завтрак', emoji: '🌅' },
  lunch: { label: 'Обед', emoji: '☀️' },
  dinner: { label: 'Ужин', emoji: '🌙' },
  snack: { label: 'Перекус', emoji: '🍏' },
};

const STORE = {
  recipes: 'pp_recipes_v1',
  shopping: 'pp_shopping_v1',
  fridge: 'pp_fridge_v1',
  deleted: 'pp_deleted_bank_v1', // id рецептов банка, удалённых пользователем
  diary: 'pp_diary_v1',          // { 'YYYY-MM-DD': [ {id,rid,title,meal,base:{kcal,p,f,c},portions} ] }
  goal: 'pp_goal_v1',            // цель по калориям
  shortcut: 'pp_shortcut_v1',    // имя Команды Shortcuts
};
const DEFAULT_GOAL = 1800;
const DEFAULT_SHORTCUT = 'ПП Здоровье';

// ---- Состояние --------------------------------------------------------------
let recipes = [];        // все рецепты (seed + пользовательские)
let shopping = [];       // [{id, name, cat, checked, manual, g}]
let fridge = [];         // ids ингредиентов «в холодильнике»
let draftIngredients = []; // черновик при добавлении рецепта: [{id, g}]
let diary = {};          // журнал питания по датам
let goalKcal = DEFAULT_GOAL;
let shortcutName = DEFAULT_SHORTCUT;
let diaryDate = '';      // выбранная дата (YYYY-MM-DD)

// ---- Утилиты ----------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function uid() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- КБЖУ -------------------------------------------------------------------
/** Считает суммарный и на порцию КБЖУ рецепта. */
function computeNutrition(recipe) {
  const total = { kcal: 0, p: 0, f: 0, c: 0, weight: 0 };
  for (const item of recipe.ingredients) {
    const ing = ING_BY_ID[item.id];
    if (!ing) continue;
    const k = item.g / 100;
    total.kcal += ing.kcal * k;
    total.p += ing.p * k;
    total.f += ing.f * k;
    total.c += ing.c * k;
    total.weight += item.g;
  }
  const servings = recipe.servings || 1;
  const per = {
    kcal: total.kcal / servings, p: total.p / servings,
    f: total.f / servings, c: total.c / servings, weight: total.weight / servings,
  };
  return {
    total: roundObj(total), per: roundObj(per),
    // КБЖУ на 100 г — удобно для сравнения «диетичности»
    per100: total.weight ? roundObj({
      kcal: total.kcal / total.weight * 100, p: total.p / total.weight * 100,
      f: total.f / total.weight * 100, c: total.c / total.weight * 100,
    }) : { kcal: 0, p: 0, f: 0, c: 0 },
  };
}
function roundObj(o) {
  const r = {};
  for (const k in o) r[k] = Math.round(o[k] * 10) / 10;
  return r;
}

/**
 * Единая точка получения КБЖУ рецепта.
 * Если у рецепта есть авторские значения (recipe.nutrition, на порцию) — берём их,
 * а вес порции считаем из ингредиентов. Иначе — считаем всё из ингредиентов.
 */
function nutritionOf(recipe) {
  const comp = computeNutrition(recipe);
  if (recipe.nutrition && typeof recipe.nutrition.kcal === 'number') {
    const s = recipe.servings || 1;
    const w = comp.per.weight; // вес порции из состава
    const per = { kcal: recipe.nutrition.kcal, p: recipe.nutrition.p, f: recipe.nutrition.f, c: recipe.nutrition.c, weight: w };
    const total = { kcal: per.kcal * s, p: per.p * s, f: per.f * s, c: per.c * s, weight: comp.total.weight };
    const per100 = w ? roundObj({ kcal: per.kcal / w * 100, p: per.p / w * 100, f: per.f / w * 100, c: per.c / w * 100 })
      : { kcal: 0, p: 0, f: 0, c: 0 };
    return { total: roundObj(total), per: roundObj(per), per100, stated: true };
  }
  return { ...comp, stated: false };
}

// ---- Картинка-заглушка (SVG, оффлайн) --------------------------------------
// Мемоизируем: одна и та же заглушка строится один раз, а не на каждый рендер
// (важно для плавности при поиске/скролле 84 карточек).
const _phCache = new Map();
const PH_PALETTES = [
  ['#34C759', '#248A3D'], ['#FF9F0A', '#C8730A'], ['#0A84FF', '#0060DF'],
  ['#FF375F', '#C81E45'], ['#BF5AF2', '#8E39C0'], ['#64D2FF', '#0A84FF'],
  ['#FFD60A', '#E0A100'], ['#5E5CE6', '#3634A3'],
];
function placeholderImage(recipe) {
  const emoji = recipe.emoji || MEALS[recipe.meal]?.emoji || '🍽️';
  const key = recipe.id + '|' + emoji;
  const hit = _phCache.get(key);
  if (hit) return hit;
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  const [c1, c2] = PH_PALETTES[h % PH_PALETTES.length];
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='260'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/>` +
    `</linearGradient></defs>` +
    `<rect width='400' height='260' fill='url(#g)'/>` +
    `<text x='200' y='158' font-size='120' text-anchor='middle'>${emoji}</text>` +
    `</svg>`;
  const uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  _phCache.set(key, uri);
  return uri;
}
const recipeImage = (r) => r.image || placeholderImage(r);

/** Небольшой дебаунс для поисковых полей — меньше перерисовок, плавнее ввод. */
function debounce(fn, ms = 130) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ============================================================================
// Инициализация
// ============================================================================
const SEED_VERSION = 2; // повышать при обновлении банка рецептов
const STORE_SEEDV = 'pp_seed_v';

function init() {
  const stored = load(STORE.recipes, null);
  if (!stored) {
    // первый запуск — засеиваем банком
    recipes = SEED_RECIPES.map((r) => ({ ...r }));
    save(STORE.recipes, recipes);
    localStorage.setItem(STORE_SEEDV, String(SEED_VERSION));
  } else {
    recipes = stored;
    migrateSeed();     // убрать старые демо-заглушки (разово)
  }
  reconcileBank();     // ВСЕГДА гарантируем наличие всех рецептов банка (кроме удалённых)
  shopping = load(STORE.shopping, []);
  fridge = load(STORE.fridge, []);
  diary = load(STORE.diary, {});
  goalKcal = load(STORE.goal, DEFAULT_GOAL);
  shortcutName = load(STORE.shortcut, DEFAULT_SHORTCUT);
  diaryDate = todayStr();

  bindTabs();
  bindFridge();
  bindRecipes();
  bindAddForm();
  bindShopping();
  bindDiary();
  bindPullToRefresh();

  renderFridgeIngredients();
  renderRecipes();
  renderShopping();
  renderAddIngredientOptions();
  renderDiary();

  registerSW();
}

/**
 * Досборка банка: добавляет рецепты банка, которых нет в базе (по id),
 * кроме тех, что пользователь удалил вручную. Идемпотентна, дешёвая —
 * запускается при каждом старте и по свайпу вниз. Возвращает число добавленных.
 */
function reconcileBank() {
  const deleted = new Set(load(STORE.deleted, []));
  const have = new Set(recipes.map((r) => r.id));
  const additions = SEED_RECIPES
    .filter((r) => !have.has(r.id) && !deleted.has(r.id))
    .map((r) => ({ ...r }));
  if (additions.length) {
    recipes = additions.concat(recipes);
    try { save(STORE.recipes, recipes); } catch { /* нет места */ }
  }
  return additions.length;
}

/**
 * Догоняющая миграция для уже установленных копий приложения:
 * — удаляет старые рецепты-заглушки (id 'seed_…', не пользовательские);
 * — добавляет рецепты банка, которых ещё нет (по id);
 * — пользовательские рецепты не трогает.
 */
function migrateSeed() {
  const sv = parseInt(localStorage.getItem(STORE_SEEDV) || '1', 10);
  if (sv >= SEED_VERSION) return;

  // 1) убрать старые демо-рецепты (seed_*), пользовательские (custom) сохранить
  recipes = recipes.filter((r) => !(String(r.id).startsWith('seed_') && !r.custom));

  // 2) добавить недостающие рецепты банка
  const have = new Set(recipes.map((r) => r.id));
  const additions = SEED_RECIPES.filter((r) => !have.has(r.id)).map((r) => ({ ...r }));
  if (additions.length) recipes = additions.concat(recipes);

  try {
    save(STORE.recipes, recipes);
    localStorage.setItem(STORE_SEEDV, String(SEED_VERSION));
  } catch { /* нет места — оставим как есть */ }
}

// ---- Вкладки ----------------------------------------------------------------
function bindTabs() {
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}
function switchTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  window.scrollTo({ top: 0 });
}

// ============================================================================
// Вкладка «Холодильник» — подбор рецепта по ингредиентам и приёму пищи
// ============================================================================
function bindFridge() {
  $('#fridge-search').addEventListener('input', debounce(renderFridgeIngredients, 130));
  $('#fridge-find').addEventListener('click', findRecipes);
  $('#fridge-clear').addEventListener('click', () => {
    fridge = []; save(STORE.fridge, fridge);
    renderFridgeIngredients(); $('#fridge-results').innerHTML = '';
  });
  // Делегирование: один обработчик на всё облако продуктов — переключаем чип
  // на месте, без перерисовки 114 кнопок (главный источник лагов).
  $('#fridge-ingredients').addEventListener('click', (e) => {
    const b = e.target.closest('.ing-chip');
    if (!b) return;
    const id = b.dataset.id;
    if (fridge.includes(id)) fridge = fridge.filter((x) => x !== id);
    else fridge.push(id);
    b.classList.toggle('on', fridge.includes(id));
    save(STORE.fridge, fridge);
    updateFridgeCount();
  });
  $('#meal-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) chip.classList.toggle('active');
  });
  // делегирование на результатах подбора: «докупить» и открытие карточки
  $('#fridge-results').addEventListener('click', (e) => {
    const add = e.target.closest('.miss-add');
    if (add) {
      e.stopPropagation();
      addToShopping(add.dataset.ing);
      add.textContent = '✓ в списке'; add.classList.add('added'); add.disabled = true;
      return;
    }
    const card = e.target.closest('.rcard');
    if (card) openRecipe(card.dataset.open);
  });
}

function updateFridgeCount() {
  $('#fridge-count').textContent = fridge.length ? `Выбрано: ${fridge.length}` : '';
}

function renderFridgeIngredients() {
  const q = $('#fridge-search').value.trim().toLowerCase();
  const qWords = q ? q.replace(/[.,()/%]/g, ' ').split(/\s+/).filter(Boolean) : [];
  const box = $('#fridge-ingredients');
  const chosen = new Set(fridge);
  const list = INGREDIENTS
    .filter(([, name]) => !qWords.length || textMatches(name, qWords))
    .sort((a, b) => a[1].localeCompare(b[1]));

  box.innerHTML = list.map(([id, name]) =>
    `<button class="ing-chip ${chosen.has(id) ? 'on' : ''}" data-id="${id}">${esc(name)}</button>`
  ).join('') || `<p class="muted">Ничего не найдено</p>`;

  updateFridgeCount();
}

function selectedMeals() {
  return $$('#meal-filter .chip.active').map((c) => c.dataset.meal);
}

/** Ранжирует рецепты: чем больше совпавших ингредиентов и меньше недостающих. */
function findRecipes() {
  const have = new Set(fridge);
  const meals = selectedMeals();
  const box = $('#fridge-results');

  if (have.size === 0) {
    box.innerHTML = `<p class="muted">Отметьте, что есть в холодильнике 👆</p>`;
    return;
  }

  const scored = recipes
    .filter((r) => meals.length === 0 || meals.includes(r.meal))
    .map((r) => {
      const ids = r.ingredients.map((i) => i.id);
      const matched = ids.filter((id) => have.has(id));
      const missing = ids.filter((id) => !have.has(id));
      const ratio = matched.length / ids.length;
      return { r, matched, missing, ratio };
    })
    .filter((x) => x.matched.length > 0)
    .sort((a, b) =>
      b.ratio - a.ratio || a.missing.length - b.missing.length ||
      nutritionOf(a.r).per.kcal - nutritionOf(b.r).per.kcal);

  if (scored.length === 0) {
    box.innerHTML = `<p class="muted">Подходящих рецептов нет. Добавьте ингредиенты или новый рецепт.</p>`;
    return;
  }

  box.innerHTML = `<h3 class="results-title">Нашлось рецептов: ${scored.length}</h3>` +
    scored.map(({ r, missing, ratio }) => {
      const n = nutritionOf(r).per;
      const pct = Math.round(ratio * 100);
      const missText = missing.length
        ? `<div class="miss">Докупить: ${missing.map((id) =>
            `<button class="miss-add" data-ing="${id}">+ ${esc(ING_BY_ID[id]?.name || id)}</button>`).join(' ')}</div>`
        : `<div class="have-all">✓ Всё есть!</div>`;
      return `<article class="rcard" data-open="${r.id}">
        <div class="rcard-badge ${pct === 100 ? 'full' : ''}">${pct}%</div>
        <img class="rcard-img" src="${recipeImage(r)}" alt="" loading="lazy" decoding="async" width="120" height="120">
        <div class="rcard-body">
          <div class="rcard-meal">${MEALS[r.meal].emoji} ${MEALS[r.meal].label} · ⏱ ${r.time} мин</div>
          <h4>${esc(r.title)}</h4>
          <div class="kbju-mini">${n.kcal} ккал · Б ${n.p} · Ж ${n.f} · У ${n.c}</div>
          ${missText}
        </div>
      </article>`;
    }).join('');
}

// ============================================================================
// Вкладка «Рецепты» — просмотр, поиск по ингредиентам, открытие карточки
// ============================================================================
function bindRecipes() {
  $('#recipe-search').addEventListener('input', debounce(renderRecipes, 130));
  $('#recipe-meal-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#recipe-meal-filter .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    renderRecipes();
  });
  // делегированное открытие карточки
  $('#recipe-list').addEventListener('click', (e) => {
    const card = e.target.closest('.rcard');
    if (card) openRecipe(card.dataset.open);
  });
}

// ---- Поиск: устойчивое сопоставление слов (учёт мн.ч. и падежей) -----------
// Индекс слов рецепта (название + теги + названия ингредиентов), кэш по id.
const _searchIdx = new Map();
function recipeWords(r) {
  let w = _searchIdx.get(r.id);
  if (w) return w;
  const text = [
    r.title,
    (r.tags || []).join(' '),
    r.ingredients.map((i) => ING_BY_ID[i.id]?.name || '').join(' '),
  ].join(' ').toLowerCase();
  w = text.replace(/[.,()/%]/g, ' ').split(/\s+/).filter(Boolean);
  _searchIdx.set(r.id, w);
  return w;
}
/** Совпадают ли слово-запрос и слово-цель: подстрока или общий корень.
 * Ловит «помидоры→помидор», «яйца→яйцо», «огурцы→огурец», но НЕ цепляет
 * короткие предлоги («с», «со», «на»), иначе поиск ловил бы почти всё. */
function wordMatch(qw, w) {
  if (qw.length >= 3 && w.includes(qw)) return true;                 // слово содержит запрос
  if (qw.length >= 4 && w.length >= 4 && qw.includes(w)) return true; // запрос содержит основу слова
  let k = 0; const m = Math.min(qw.length, w.length);
  while (k < m && qw[k] === w[k]) k++;
  if (m >= 3 && k >= 4) return true;              // длинный общий корень
  if (m >= 3 && k >= 3 && k >= m - 1) return true; // короткие формы: яйца/яйцо, огурцы/огурец
  return false;
}
/** Рецепт подходит, если КАЖДОЕ слово запроса нашло пару в словах рецепта. */
function recipeMatches(r, qWords) {
  const words = recipeWords(r);
  return qWords.every((qw) => words.some((w) => wordMatch(qw, w)));
}
/** То же для произвольного текста (напр. названия продукта). */
function textMatches(text, qWords) {
  const ws = text.toLowerCase().replace(/[.,()/%]/g, ' ').split(/\s+/).filter(Boolean);
  return qWords.every((qw) => ws.some((w) => wordMatch(qw, w)));
}

function renderRecipes() {
  const q = $('#recipe-search').value.trim().toLowerCase();
  const qWords = q ? q.replace(/[.,()/%]/g, ' ').split(/\s+/).filter(Boolean) : [];
  const meal = $('#recipe-meal-filter .chip.active')?.dataset.meal || 'all';
  const box = $('#recipe-list');

  const filtered = recipes.filter((r) => {
    if (meal !== 'all' && r.meal !== meal) return false;
    if (!qWords.length) return true;
    return recipeMatches(r, qWords);
  });

  $('#recipe-total').textContent = `${recipes.length} рецептов в базе`;

  if (filtered.length === 0) {
    box.innerHTML = `<p class="muted">Ничего не найдено. Попробуйте другой запрос.</p>`;
    return;
  }

  box.innerHTML = filtered.map((r) => {
    const n = nutritionOf(r).per;
    return `<article class="rcard" data-open="${r.id}">
      <img class="rcard-img" src="${recipeImage(r)}" alt="" loading="lazy" decoding="async" width="120" height="120">
      <div class="rcard-body">
        <div class="rcard-meal">${MEALS[r.meal].emoji} ${MEALS[r.meal].label} · ⏱ ${r.time} мин · 🍽 ${r.servings} порц.</div>
        <h4>${esc(r.title)}</h4>
        <div class="kbju-mini">${n.kcal} ккал · Б ${n.p} · Ж ${n.f} · У ${n.c}</div>
        <div class="rcard-tags">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>
    </article>`;
  }).join('');
}

// ---- Модальное окно рецепта -------------------------------------------------
function openRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  const nut = nutritionOf(r);
  const modal = $('#recipe-modal');

  $('#modal-content').innerHTML = `
    <img class="modal-img" src="${recipeImage(r)}" alt="">
    <div class="modal-inner">
      <div class="rcard-meal">${MEALS[r.meal].emoji} ${MEALS[r.meal].label} · ⏱ ${r.time} мин · 🍽 ${r.servings} порц.</div>
      <h2>${esc(r.title)}</h2>
      <div class="rcard-tags">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>

      <div class="kbju-grid">
        <div class="kbju-cell"><span class="v">${nut.per.kcal}</span><span class="l">ккал</span></div>
        <div class="kbju-cell"><span class="v">${nut.per.p}</span><span class="l">белки</span></div>
        <div class="kbju-cell"><span class="v">${nut.per.f}</span><span class="l">жиры</span></div>
        <div class="kbju-cell"><span class="v">${nut.per.c}</span><span class="l">углев.</span></div>
      </div>
      <p class="kbju-note">на порцию (~${nut.per.weight} г) · на 100 г: ${nut.per100.kcal} ккал</p>

      <div class="modal-cta">
        <button class="btn btn-primary" id="modal-add-diary">🍽️ Съедено — в дневник</button>
        <button class="btn btn-secondary" id="modal-health">❤️ Записать в Здоровье</button>
      </div>

      <h3>Ингредиенты <span class="muted">(на ${r.servings} порц.)</span></h3>
      <ul class="ing-list">
        ${r.ingredients.map((i) => {
          const ing = ING_BY_ID[i.id];
          return `<li><span>${esc(ing?.name || i.id)}</span><span class="g">${i.g} г</span></li>`;
        }).join('')}
      </ul>
      <button class="btn btn-secondary" id="modal-add-shopping">🛒 Добавить всё в список покупок</button>

      <h3>Приготовление</h3>
      <ol class="steps">
        ${(r.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}
      </ol>

      <button class="btn btn-danger" id="modal-delete">🗑 Удалить рецепт</button>
    </div>`;

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  $('#modal-add-shopping').addEventListener('click', () => {
    r.ingredients.forEach((i) => addToShopping(i.id, i.g));
    $('#modal-add-shopping').textContent = '✓ Добавлено в покупки';
    $('#modal-add-shopping').disabled = true;
  });
  $('#modal-add-diary').addEventListener('click', () => {
    addToDiary(r);
    $('#modal-add-diary').textContent = '✓ Записано в дневник';
    $('#modal-add-diary').disabled = true;
  });
  $('#modal-health').addEventListener('click', () => {
    const p = nutritionOf(r).per;
    logToHealth(p.kcal, p.p, p.f, p.c, r.title);
  });
  const del = $('#modal-delete');
  if (del) del.addEventListener('click', () => {
    if (confirm('Удалить этот рецепт?')) {
      // если это рецепт банка — запомним, чтобы досборка не вернула его обратно
      if (r.bank || String(id).startsWith('bk')) {
        const d = new Set(load(STORE.deleted, []));
        d.add(id); save(STORE.deleted, [...d]);
      }
      recipes = recipes.filter((x) => x.id !== id);
      save(STORE.recipes, recipes);
      closeModal(); renderRecipes();
    }
  });
}
function closeModal() {
  $('#recipe-modal').classList.remove('open');
  document.body.style.overflow = '';
}

// ============================================================================
// Вкладка «Добавить рецепт» — с авторасчётом КБЖУ
// ============================================================================
function bindAddForm() {
  $('#add-ing-btn').addEventListener('click', addDraftIngredient);
  $('#add-ing-select').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addDraftIngredient(); }
  });
  $('#recipe-photo').addEventListener('change', handlePhoto);
  $('#add-form').addEventListener('submit', saveNewRecipe);
  $('#servings').addEventListener('input', renderDraftNutrition);
  // импорт / экспорт
  $('#export-btn').addEventListener('click', exportRecipes);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', importRecipes);
}

function renderAddIngredientOptions() {
  const sel = $('#add-ing-select');
  const groups = {};
  for (const [id, name, cat] of INGREDIENTS) {
    (groups[cat] ||= []).push([id, name]);
  }
  sel.innerHTML = Object.entries(groups).map(([cat, items]) =>
    `<optgroup label="${CATEGORIES[cat] || cat}">` +
    items.sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('') +
    `</optgroup>`).join('');
}

function addDraftIngredient() {
  const id = $('#add-ing-select').value;
  const g = parseFloat($('#add-ing-grams').value);
  if (!id || !g || g <= 0) { toast('Укажите ингредиент и граммы'); return; }
  const existing = draftIngredients.find((i) => i.id === id);
  if (existing) existing.g += g; else draftIngredients.push({ id, g });
  $('#add-ing-grams').value = '';
  renderDraft();
}

function renderDraft() {
  const box = $('#draft-ings');
  if (draftIngredients.length === 0) {
    box.innerHTML = `<p class="muted">Пока пусто — добавьте ингредиенты выше.</p>`;
  } else {
    box.innerHTML = draftIngredients.map((i, idx) => {
      const ing = ING_BY_ID[i.id];
      return `<div class="draft-row">
        <span>${esc(ing?.name || i.id)}</span>
        <span class="draft-g">${i.g} г</span>
        <button type="button" class="draft-del" data-idx="${idx}">✕</button>
      </div>`;
    }).join('');
    $$('.draft-del', box).forEach((b) => b.addEventListener('click', () => {
      draftIngredients.splice(+b.dataset.idx, 1);
      renderDraft();
    }));
  }
  renderDraftNutrition();
}

function renderDraftNutrition() {
  const servings = Math.max(1, parseInt($('#servings').value) || 1);
  const fake = { ingredients: draftIngredients, servings };
  const n = computeNutrition(fake);
  $('#draft-kbju').innerHTML = `
    <div class="kbju-cell"><span class="v">${n.per.kcal}</span><span class="l">ккал</span></div>
    <div class="kbju-cell"><span class="v">${n.per.p}</span><span class="l">белки</span></div>
    <div class="kbju-cell"><span class="v">${n.per.f}</span><span class="l">жиры</span></div>
    <div class="kbju-cell"><span class="v">${n.per.c}</span><span class="l">углев.</span></div>`;
  $('#draft-kbju-note').textContent = draftIngredients.length
    ? `на порцию (~${n.per.weight} г) · всего блюдо: ${n.total.kcal} ккал / ${n.total.weight} г`
    : '';
}

let draftPhoto = null;
function handlePhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  // Сжимаем в data URL, чтобы влезало в localStorage и работало оффлайн
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 800;
      let { width, height } = img;
      if (width > max || height > max) {
        const k = Math.min(max / width, max / height);
        width = Math.round(width * k); height = Math.round(height * k);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      draftPhoto = canvas.toDataURL('image/jpeg', 0.8);
      $('#photo-preview').src = draftPhoto;
      $('#photo-preview').style.display = 'block';
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function saveNewRecipe(e) {
  e.preventDefault();
  const title = $('#recipe-title').value.trim();
  if (!title) { toast('Введите название'); return; }
  if (draftIngredients.length === 0) { toast('Добавьте хотя бы один ингредиент'); return; }

  const steps = $('#recipe-steps').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const tags = $('#recipe-tags').value.split(',').map((s) => s.trim()).filter(Boolean);

  const recipe = {
    id: uid(),
    title,
    meal: $('#recipe-meal').value,
    time: Math.max(1, parseInt($('#recipe-time').value) || 15),
    servings: Math.max(1, parseInt($('#servings').value) || 1),
    emoji: $('#recipe-emoji').value.trim() || '🍽️',
    ingredients: draftIngredients.map((i) => ({ ...i })),
    steps,
    tags,
    image: draftPhoto || null,
    custom: true,
  };

  recipes.unshift(recipe);
  try {
    save(STORE.recipes, recipes);
  } catch (err) {
    recipes.shift();
    toast('Недостаточно места — попробуйте фото меньшего размера');
    return;
  }

  // сброс формы
  $('#add-form').reset();
  draftIngredients = []; draftPhoto = null;
  $('#photo-preview').style.display = 'none';
  renderDraft();
  renderRecipes();
  toast('✓ Рецепт сохранён!');
  switchTab('recipes');
}

// ---- Импорт / экспорт рецептов ----------------------------------------------
const IO_FORMAT = 'pp-recipes';

function exportRecipes() {
  if (recipes.length === 0) { toast('Нет рецептов для экспорта'); return; }
  const payload = { app: IO_FORMAT, version: 1, exported: new Date().toISOString(), recipes };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `pp-recipes-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`✓ Экспортировано рецептов: ${recipes.length}`);
}

/** Проверяет, что объект похож на рецепт нашего формата. */
function isValidRecipe(r) {
  return r && typeof r.title === 'string' && r.title.trim() &&
    Array.isArray(r.ingredients) &&
    r.ingredients.every((i) => i && typeof i.id === 'string' && typeof i.g === 'number') &&
    Object.prototype.hasOwnProperty.call(MEALS, r.meal);
}

function importRecipes(e) {
  const file = e.target.files[0];
  e.target.value = ''; // сброс, чтобы можно было выбрать тот же файл повторно
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { toast('Не удалось прочитать файл (не JSON)'); return; }

    // принимаем как {recipes:[...]}, так и просто массив рецептов
    const incoming = Array.isArray(data) ? data
      : (data && Array.isArray(data.recipes) ? data.recipes : null);
    if (!incoming) { toast('Файл не содержит рецептов'); return; }

    const existingIds = new Set(recipes.map((r) => r.id));
    let added = 0, skippedDup = 0, skippedBad = 0;

    for (const raw of incoming) {
      if (!isValidRecipe(raw)) { skippedBad++; continue; }
      // защита от точного дубля (тот же id ИЛИ то же название+приём пищи)
      const dupByTitle = recipes.some((r) =>
        r.title.trim().toLowerCase() === raw.title.trim().toLowerCase() && r.meal === raw.meal);
      if (existingIds.has(raw.id) || dupByTitle) { skippedDup++; continue; }

      const recipe = {
        id: uid(),
        title: String(raw.title).trim(),
        meal: raw.meal,
        time: Math.max(1, parseInt(raw.time) || 15),
        servings: Math.max(1, parseInt(raw.servings) || 1),
        emoji: (raw.emoji && String(raw.emoji).slice(0, 4)) || '🍽️',
        ingredients: raw.ingredients
          .filter((i) => typeof i.id === 'string' && i.g > 0)
          .map((i) => ({ id: i.id, g: Math.round(i.g) })),
        steps: Array.isArray(raw.steps) ? raw.steps.map(String) : [],
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        image: typeof raw.image === 'string' && raw.image.startsWith('data:') ? raw.image : null,
        custom: true,
      };
      // сохранить авторские КБЖУ, если они были в файле
      if (raw.nutrition && typeof raw.nutrition.kcal === 'number') {
        recipe.nutrition = {
          kcal: +raw.nutrition.kcal, p: +raw.nutrition.p || 0,
          f: +raw.nutrition.f || 0, c: +raw.nutrition.c || 0,
        };
      }
      recipes.unshift(recipe);
      existingIds.add(recipe.id);
      added++;
    }

    if (added === 0) {
      toast(skippedDup ? 'Все рецепты уже есть в базе' : 'Подходящих рецептов не найдено');
      return;
    }
    try {
      save(STORE.recipes, recipes);
    } catch {
      recipes.splice(0, added); // откат
      toast('Недостаточно места (фото в рецептах слишком большие)');
      return;
    }
    renderRecipes();
    const extra = [skippedDup ? `дублей: ${skippedDup}` : '', skippedBad ? `пропущено: ${skippedBad}` : '']
      .filter(Boolean).join(', ');
    toast(`✓ Импортировано: ${added}${extra ? ' (' + extra + ')' : ''}`);
    switchTab('recipes');
  };
  reader.readAsText(file);
}

// ============================================================================
// Вкладка «Покупки»
// ============================================================================
function bindShopping() {
  $('#shop-add-btn').addEventListener('click', () => {
    const v = $('#shop-manual').value.trim();
    if (!v) return;
    shopping.push({ id: 'm_' + uid(), name: v, cat: 'other', checked: false, manual: true });
    $('#shop-manual').value = '';
    save(STORE.shopping, shopping); renderShopping();
  });
  $('#shop-manual').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#shop-add-btn').click(); }
  });
  $('#shop-clear-checked').addEventListener('click', () => {
    shopping = shopping.filter((s) => !s.checked);
    save(STORE.shopping, shopping); renderShopping();
  });
  $('#shop-clear-all').addEventListener('click', () => {
    if (shopping.length && confirm('Очистить весь список покупок?')) {
      shopping = []; save(STORE.shopping, shopping); renderShopping();
    }
  });
}

function addToShopping(ingId, g) {
  const ing = ING_BY_ID[ingId];
  const existing = shopping.find((s) => s.id === ingId);
  if (existing) {
    if (g) existing.g = (existing.g || 0) + g;
    existing.checked = false;
  } else {
    shopping.push({
      id: ingId, name: ing?.name || ingId, cat: ing?.cat || 'other',
      checked: false, g: g || 0,
    });
  }
  save(STORE.shopping, shopping);
  renderShopping();
  updateShopBadge();
}

function renderShopping() {
  const box = $('#shopping-list');
  updateShopBadge();
  if (shopping.length === 0) {
    box.innerHTML = `<p class="muted">Список пуст. Добавляйте ингредиенты из рецептов 🛒</p>`;
    return;
  }
  // Группировка по категориям
  const groups = {};
  shopping.forEach((s) => (groups[s.cat] ||= []).push(s));

  box.innerHTML = Object.entries(groups).map(([cat, items]) =>
    `<div class="shop-group">
      <h4>${CATEGORIES[cat] || '🧂 Прочее'}</h4>
      ${items.map((s) => {
        const idx = shopping.indexOf(s);
        const amount = s.g ? `<span class="shop-g">${Math.round(s.g)} г</span>` : '';
        return `<label class="shop-item ${s.checked ? 'done' : ''}">
          <input type="checkbox" data-idx="${idx}" ${s.checked ? 'checked' : ''}>
          <span class="shop-name">${esc(s.name)}</span>
          ${amount}
        </label>`;
      }).join('')}
    </div>`).join('');

  $$('#shopping-list input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', () => {
      shopping[+cb.dataset.idx].checked = cb.checked;
      save(STORE.shopping, shopping); renderShopping();
    }));
}

function updateShopBadge() {
  const n = shopping.filter((s) => !s.checked).length;
  const badge = $('#shop-badge');
  badge.textContent = n; badge.style.display = n ? 'flex' : 'none';
}

// ============================================================================
// Вкладка «Дневник» — журнал питания + запись в Apple Health через Shortcuts
// ============================================================================
function pad2(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayStr() { return toDateStr(new Date()); }
function shiftDate(str, days) {
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toDateStr(dt);
}
function dateLabel(str) {
  if (str === todayStr()) return 'Сегодня';
  if (str === shiftDate(todayStr(), -1)) return 'Вчера';
  const [y, m, d] = str.split('-');
  return `${d}.${m}.${y}`;
}

function bindDiary() {
  $('#diary-prev').addEventListener('click', () => { diaryDate = shiftDate(diaryDate, -1); renderDiary(); });
  $('#diary-next').addEventListener('click', () => {
    const nd = shiftDate(diaryDate, 1);
    if (nd > todayStr()) return; // не заглядываем в будущее
    diaryDate = nd; renderDiary();
  });
  $('#diary-health').addEventListener('click', () => {
    const t = diaryTotals(diaryDate);
    if (t.kcal <= 0) { toast('За этот день пока ничего нет'); return; }
    logToHealth(t.kcal, t.p, t.f, t.c, `Питание за ${dateLabel(diaryDate)}`);
  });
  const gi = $('#goal-input');
  gi.value = goalKcal || '';
  gi.addEventListener('input', debounce(() => {
    goalKcal = Math.max(0, parseInt(gi.value) || 0) || DEFAULT_GOAL;
    save(STORE.goal, goalKcal); renderDiary();
  }, 250));
  const si = $('#shortcut-input');
  si.value = shortcutName || '';
  si.addEventListener('input', debounce(() => {
    shortcutName = si.value.trim() || DEFAULT_SHORTCUT;
    save(STORE.shortcut, shortcutName);
  }, 250));

  // делегирование действий в списке дневника
  $('#diary-list').addEventListener('click', (e) => {
    const row = e.target.closest('.diary-item');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.diary-del')) return removeDiaryEntry(id);
    if (e.target.closest('.diary-plus')) return changePortions(id, +0.5);
    if (e.target.closest('.diary-minus')) return changePortions(id, -0.5);
    if (e.target.closest('.diary-heart')) {
      const entry = (diary[diaryDate] || []).find((x) => x.id === id);
      if (entry) { const k = entry.portions; logToHealth(entry.base.kcal * k, entry.base.p * k, entry.base.f * k, entry.base.c * k, entry.title); }
    }
  });
}

function addToDiary(recipe) {
  const per = nutritionOf(recipe).per;
  const day = diary[diaryDate] || (diary[diaryDate] = []);
  day.push({
    id: uid(), rid: recipe.id, title: recipe.title, meal: recipe.meal,
    base: { kcal: per.kcal, p: per.p, f: per.f, c: per.c }, portions: 1,
  });
  save(STORE.diary, diary);
  renderDiary();
  toast(`✓ «${recipe.title}» — в дневник`);
}
function removeDiaryEntry(id) {
  diary[diaryDate] = (diary[diaryDate] || []).filter((x) => x.id !== id);
  save(STORE.diary, diary); renderDiary();
}
function changePortions(id, delta) {
  const entry = (diary[diaryDate] || []).find((x) => x.id === id);
  if (!entry) return;
  entry.portions = Math.max(0.5, Math.round((entry.portions + delta) * 2) / 2);
  save(STORE.diary, diary); renderDiary();
}
function diaryTotals(date) {
  const t = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const e of diary[date] || []) {
    t.kcal += e.base.kcal * e.portions;
    t.p += e.base.p * e.portions;
    t.f += e.base.f * e.portions;
    t.c += e.base.c * e.portions;
  }
  return { kcal: Math.round(t.kcal), p: Math.round(t.p), f: Math.round(t.f), c: Math.round(t.c) };
}

function renderDiary() {
  $('#diary-date').textContent = dateLabel(diaryDate);
  $('#diary-next').disabled = diaryDate >= todayStr();

  const t = diaryTotals(diaryDate);
  $('#diary-kcal').textContent = t.kcal;
  $('#diary-goal').textContent = goalKcal;
  $('#diary-p').textContent = t.p;
  $('#diary-f').textContent = t.f;
  $('#diary-c').textContent = t.c;
  const pct = goalKcal ? Math.min(100, Math.round(t.kcal / goalKcal * 100)) : 0;
  const bar = $('#diary-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('over', t.kcal > goalKcal);
  const left = goalKcal - t.kcal;
  $('#diary-left').textContent = left >= 0 ? `осталось ${left}` : `перебор ${-left}`;

  const list = $('#diary-list');
  const items = diary[diaryDate] || [];
  if (items.length === 0) {
    list.innerHTML = `<p class="muted">Пусто. Откройте рецепт и нажмите «Съедено — в дневник» 🍽️</p>`;
    return;
  }
  list.innerHTML = items.map((e) => {
    const kcal = Math.round(e.base.kcal * e.portions);
    const portionsLabel = e.portions === 1 ? '' : `<span class="diary-portions">×${e.portions}</span>`;
    return `<div class="diary-item" data-id="${e.id}">
      <div class="diary-main">
        <div class="diary-title">${MEALS[e.meal]?.emoji || '🍽️'} ${esc(e.title)} ${portionsLabel}</div>
        <div class="diary-kbju">${kcal} ккал · Б ${Math.round(e.base.p * e.portions)} · Ж ${Math.round(e.base.f * e.portions)} · У ${Math.round(e.base.c * e.portions)}</div>
      </div>
      <div class="diary-actions">
        <button class="diary-step diary-minus" aria-label="Меньше">−</button>
        <button class="diary-step diary-plus" aria-label="Больше">+</button>
        <button class="diary-heart" aria-label="В Здоровье">❤️</button>
        <button class="diary-del" aria-label="Удалить">✕</button>
      </div>
    </div>`;
  }).join('');
}

/**
 * Запись КБЖУ в Apple Health через приложение «Команды» (Shortcuts).
 * Открывает Команду с именем shortcutName и передаёт ей строку "ккал,Б,Ж,У".
 * Работает без Apple Developer — нужна лишь один раз настроенная Команда.
 */
function logToHealth(kcal, p, f, c, label) {
  const payload = [Math.round(kcal), Math.round(p), Math.round(f), Math.round(c)].join(',');
  const url = `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName)}&input=text&text=${encodeURIComponent(payload)}`;
  // открываем схему Shortcuts (на iOS запустит Команду и вернётся обратно)
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  toast(`❤️ ${label || 'Отправлено'} → Здоровье (${Math.round(kcal)} ккал)`);
}

// ---- Тосты ------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---- Service Worker + авто-обновление ---------------------------------------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.update();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        // новая версия установлена и уже есть активный воркер → применить сразу
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          nw.postMessage('skip-waiting');
        }
      });
    });
  }).catch(() => {});

  // Когда НОВЫЙ воркер берёт управление (вышло обновление) — один раз
  // перезагружаем страницу, чтобы подхватить свежий код и рецепты.
  // Первый захват при самой первой установке (когда контроллера ещё не было)
  // пропускаем, чтобы не дёргать пользователя лишней перезагрузкой.
  let skipFirstClaim = !navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (skipFirstClaim) { skipFirstClaim = false; return; }
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

/** Проверить обновление приложения по сети (для pull-to-refresh). */
async function checkAppUpdate() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch { /* оффлайн — не страшно */ }
}

// ---- Pull-to-refresh (свайп вниз обновляет базу) ----------------------------
function bindPullToRefresh() {
  const ptr = $('#ptr');
  if (!ptr) return;
  const HIDDEN = -60;   // индикатор высотой ~60px, спрятан над экраном
  const HOLD = 14;      // позиция во время обновления
  const TRIGGER = 62;   // «показано» пикселей, при которых срабатывает
  const MAX = 96;
  let startY = 0, pulling = false, armed = false, busy = false;

  const scrollTop = () => window.scrollY || document.documentElement.scrollTop || 0;

  function blocked(target) {
    if (busy) return true;
    if ($('#recipe-modal').classList.contains('open')) return true;
    const sc = target.closest && target.closest('.ing-cloud, .chips.scroll, .modal-card');
    return !!(sc && sc.scrollTop > 0);
  }
  // shown = сколько пикселей индикатор виден (0..MAX)
  function place(shown, text, spin) {
    ptr.style.transform = `translateY(${HIDDEN + shown}px)`;
    if (text != null) ptr.querySelector('.ptr-text').textContent = text;
    ptr.classList.toggle('spin', !!spin);
  }

  window.addEventListener('touchstart', (e) => {
    if (scrollTop() > 0 || blocked(e.target)) { pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true; armed = false;
    ptr.style.transition = 'none';
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || scrollTop() > 0) { pulling = false; ptr.style.transition = 'transform .25s'; place(0); return; }
    e.preventDefault(); // придержать нативную прокрутку, пока тянем
    const shown = Math.min(dy * 0.5, MAX);
    armed = shown >= TRIGGER;
    place(shown, armed ? 'Отпустите — обновить базу' : 'Потяните вниз ↓', false);
  }, { passive: false });

  window.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    ptr.style.transition = 'transform .28s';
    if (!armed) { place(0); return; }

    busy = true;
    place(HOLD - HIDDEN, 'Обновление базы…', true); // держим индикатор видимым
    const added = reconcileBank();
    renderRecipes();
    renderAddIngredientOptions();
    await checkAppUpdate(); // при новой версии SW сам перезагрузит страницу
    place(HOLD - HIDDEN, added ? `Добавлено: ${added}` : 'База актуальна', false);
    setTimeout(() => {
      place(0);
      busy = false;
      toast(added
        ? `✓ База обновлена: +${added} (всего ${recipes.length})`
        : `✓ База актуальна: ${recipes.length} рецептов`);
    }, 700);
  });
}

// ---- Глобальные обработчики модалки -----------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  init();
  $('#modal-close').addEventListener('click', closeModal);
  $('#recipe-modal').addEventListener('click', (e) => {
    if (e.target.id === 'recipe-modal') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
});
