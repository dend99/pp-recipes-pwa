/* ============================================================================
 * app.js — «Кухонная книга». UI-слой поверх data.js / bank.js.
 * Хранение — localStorage, оффлайн. Без фреймворков.
 * ==========================================================================*/
'use strict';

const MEALS = {
  breakfast: { label: 'Завтрак', emoji: '🥣' },
  lunch: { label: 'Обед', emoji: '🍲' },
  dinner: { label: 'Ужин', emoji: '🌙' },
  snack: { label: 'Перекус', emoji: '🍎' },
};
const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_SHARE = { breakfast: 0.25, lunch: 0.35, dinner: 0.30, snack: 0.10 };

const STORE = {
  recipes: 'pp_recipes_v1', shopping: 'pp_shopping_v1', fridge: 'pp_fridge_v1',
  deleted: 'pp_deleted_bank_v1', diary: 'pp_diary_v1', goal: 'pp_goal_v1',
  shortcut: 'pp_shortcut_v1', freq: 'pp_fridge_freq_v1', fav: 'pp_favorites_v1',
  macro: 'pp_macro_goals_v1',
};
const DEFAULT_GOAL = 1800;
const DEFAULT_SHORTCUT = 'ПП Здоровье';
const SEED_VERSION = 2;
const STORE_SEEDV = 'pp_seed_v';

// ---- Состояние --------------------------------------------------------------
let recipes = [], shopping = [], fridge = [], diary = {};
let draftIngredients = [], draftPhoto = null;
let goalKcal = DEFAULT_GOAL, macroGoals = null, shortcutName = DEFAULT_SHORTCUT;
let freq = {}, favorites = [];
let diaryDate = '';

// ---- Утилиты ----------------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function load(k, f) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? f; } catch { return f; } }
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function uid() { return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function debounce(fn, ms = 130) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---- КБЖУ -------------------------------------------------------------------
function computeNutrition(recipe) {
  const total = { kcal: 0, p: 0, f: 0, c: 0, weight: 0 };
  for (const it of recipe.ingredients) {
    const ing = ING_BY_ID[it.id]; if (!ing) continue;
    const k = it.g / 100;
    total.kcal += ing.kcal * k; total.p += ing.p * k; total.f += ing.f * k; total.c += ing.c * k; total.weight += it.g;
  }
  const s = recipe.servings || 1;
  const per = { kcal: total.kcal / s, p: total.p / s, f: total.f / s, c: total.c / s, weight: total.weight / s };
  return {
    total: roundObj(total), per: roundObj(per),
    per100: total.weight ? roundObj({ kcal: total.kcal / total.weight * 100, p: total.p / total.weight * 100, f: total.f / total.weight * 100, c: total.c / total.weight * 100 }) : { kcal: 0, p: 0, f: 0, c: 0 },
  };
}
function roundObj(o) { const r = {}; for (const k in o) r[k] = Math.round(o[k] * 10) / 10; return r; }
function nutritionOf(recipe) {
  const comp = computeNutrition(recipe);
  if (recipe.nutrition && typeof recipe.nutrition.kcal === 'number') {
    const s = recipe.servings || 1, w = comp.per.weight;
    const per = { kcal: recipe.nutrition.kcal, p: recipe.nutrition.p, f: recipe.nutrition.f, c: recipe.nutrition.c, weight: w };
    const total = { kcal: per.kcal * s, p: per.p * s, f: per.f * s, c: per.c * s, weight: comp.total.weight };
    const per100 = w ? roundObj({ kcal: per.kcal / w * 100, p: per.p / w * 100, f: per.f / w * 100, c: per.c / w * 100 }) : { kcal: 0, p: 0, f: 0, c: 0 };
    return { total: roundObj(total), per: roundObj(per), per100, stated: true };
  }
  return { ...comp, stated: false };
}

// ---- Заглушка-картинка (тёплая палитра) -------------------------------------
const _phCache = new Map();
const PH_PALETTES = [['#E7D3B8', '#C9A87C'], ['#D9E2CE', '#A7B98A'], ['#EAD3C6', '#C99A82'], ['#DDE1DE', '#9FB0A6'], ['#EBE0C8', '#C9B583'], ['#D8C9DB', '#AC93B2']];
function placeholderImage(recipe) {
  const emoji = recipe.emoji || MEALS[recipe.meal]?.emoji || '🍽️';
  const key = recipe.id + '|' + emoji, hit = _phCache.get(key); if (hit) return hit;
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  const [c1, c2] = PH_PALETTES[h % PH_PALETTES.length];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs><rect width='480' height='270' fill='url(#g)'/><text x='240' y='168' font-size='120' text-anchor='middle'>${emoji}</text></svg>`;
  const uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); _phCache.set(key, uri); return uri;
}
const recipeImage = (r) => r.image || placeholderImage(r);

// ---- Поиск: сопоставление слов ----------------------------------------------
const _searchIdx = new Map();
function recipeWords(r) {
  let w = _searchIdx.get(r.id); if (w) return w;
  const text = [r.title, (r.tags || []).join(' '), r.ingredients.map((i) => ING_BY_ID[i.id]?.name || '').join(' ')].join(' ').toLowerCase();
  w = text.replace(/[.,()/%]/g, ' ').split(/\s+/).filter(Boolean); _searchIdx.set(r.id, w); return w;
}
function wordMatch(qw, w) {
  if (qw.length >= 3 && w.includes(qw)) return true;
  if (qw.length >= 4 && w.length >= 4 && qw.includes(w)) return true;
  let k = 0; const m = Math.min(qw.length, w.length); while (k < m && qw[k] === w[k]) k++;
  if (m >= 3 && k >= 4) return true;
  if (m >= 3 && k >= 3 && k >= m - 1) return true;
  return false;
}
function recipeMatches(r, qWords) { const words = recipeWords(r); return qWords.every((qw) => words.some((w) => wordMatch(qw, w))); }
function textMatches(text, qWords) { const ws = text.toLowerCase().replace(/[.,()/%]/g, ' ').split(/\s+/).filter(Boolean); return qWords.every((qw) => ws.some((w) => wordMatch(qw, w))); }
const toWords = (q) => q ? q.toLowerCase().replace(/[.,()/%]/g, ' ').split(/\s+/).filter(Boolean) : [];

// ============================================================================
// Инициализация
// ============================================================================
function init() {
  const stored = load(STORE.recipes, null);
  if (!stored) { recipes = SEED_RECIPES.map((r) => ({ ...r })); save(STORE.recipes, recipes); localStorage.setItem(STORE_SEEDV, String(SEED_VERSION)); }
  else { recipes = stored; migrateSeed(); }
  reconcileBank();
  shopping = load(STORE.shopping, []); fridge = load(STORE.fridge, []); diary = load(STORE.diary, {});
  goalKcal = load(STORE.goal, DEFAULT_GOAL); macroGoals = load(STORE.macro, null); shortcutName = load(STORE.shortcut, DEFAULT_SHORTCUT);
  freq = load(STORE.freq, {}); favorites = load(STORE.fav, []); diaryDate = todayStr();

  bindTabs(); bindToday(); bindFridge(); bindRecipes(); bindShopping(); bindAddSheet(); bindSettings(); bindPullToRefresh(); bindGlobal();
  renderToday(); renderFridge(); renderRecipes(); renderShopping(); renderAddOptions();
  registerSW();
}

function migrateSeed() {
  const sv = parseInt(localStorage.getItem(STORE_SEEDV) || '1', 10); if (sv >= SEED_VERSION) return;
  recipes = recipes.filter((r) => !(String(r.id).startsWith('seed_') && !r.custom));
  const have = new Set(recipes.map((r) => r.id));
  const add = SEED_RECIPES.filter((r) => !have.has(r.id)).map((r) => ({ ...r }));
  if (add.length) recipes = add.concat(recipes);
  try { save(STORE.recipes, recipes); localStorage.setItem(STORE_SEEDV, String(SEED_VERSION)); } catch {}
}
function reconcileBank() {
  const deleted = new Set(load(STORE.deleted, [])), have = new Set(recipes.map((r) => r.id));
  const add = SEED_RECIPES.filter((r) => !have.has(r.id) && !deleted.has(r.id)).map((r) => ({ ...r }));
  if (add.length) { recipes = add.concat(recipes); try { save(STORE.recipes, recipes); } catch {} }
  return add.length;
}

// ---- Вкладки ----------------------------------------------------------------
function bindTabs() { $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab))); }
function switchTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'today') renderToday();
  if (name === 'shopping') renderShopping();
  window.scrollTo({ top: 0 });
}

// ============================================================================
// СЕГОДНЯ
// ============================================================================
function pad2(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayStr() { return toDateStr(new Date()); }
function shiftDate(str, days) { const [y, m, d] = str.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + days); return toDateStr(dt); }
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEK = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
function dateLabel(str) {
  if (str === todayStr()) return 'Сегодня';
  if (str === shiftDate(todayStr(), -1)) return 'Вчера';
  const [y, m, d] = str.split('-').map(Number); const dt = new Date(y, m - 1, d);
  return `${WEEK[dt.getDay()]}, ${d} ${MONTHS[m - 1]}`;
}
function getMacroGoals() {
  if (macroGoals && macroGoals.p) return macroGoals;
  return { p: Math.round(goalKcal * 0.30 / 4), f: Math.round(goalKcal * 0.30 / 9), c: Math.round(goalKcal * 0.40 / 4) };
}
function diaryTotals(date) {
  const t = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const e of diary[date] || []) { t.kcal += e.base.kcal * e.portions; t.p += e.base.p * e.portions; t.f += e.base.f * e.portions; t.c += e.base.c * e.portions; }
  return { kcal: Math.round(t.kcal), p: Math.round(t.p), f: Math.round(t.f), c: Math.round(t.c) };
}

function bindToday() {
  $('#today-prev').addEventListener('click', () => { diaryDate = shiftDate(diaryDate, -1); renderToday(); });
  $('#today-next').addEventListener('click', () => { const n = shiftDate(diaryDate, 1); if (n > todayStr()) return; diaryDate = n; renderToday(); });
  $('#today-health').addEventListener('click', () => { const t = diaryTotals(diaryDate); if (t.kcal <= 0) return toast('За день пока пусто'); logToHealth(t.kcal, t.p, t.f, t.c, `Питание за ${dateLabel(diaryDate)}`); });
  $('#open-settings').addEventListener('click', openSettings);
  $('#today-plan').addEventListener('click', onPlanClick);
}
function renderToday() {
  $('#today-date').textContent = dateLabel(diaryDate);
  $('#today-prev').disabled = false; $('#today-next').disabled = diaryDate >= todayStr();
  const t = diaryTotals(diaryDate), mg = getMacroGoals(), over = t.kcal > goalKcal;
  $('#today-kcal').textContent = t.kcal;
  const left = goalKcal - t.kcal;
  $('#today-left').innerHTML = left >= 0 ? `Осталось <b>${left} ккал</b> из ${goalKcal}` : `Перебор <b>${-left} ккал</b> из ${goalKcal}`;
  $('#today-left').classList.toggle('over', over);
  const pct = goalKcal ? Math.min(t.kcal / goalKcal, 1) : 0;
  $('#today-ring').style.background = `conic-gradient(${over ? 'var(--warn)' : 'var(--accent)'} ${pct * 360}deg, var(--paper-3) 0deg)`;
  const setMacro = (k, id, bar) => { $(id).textContent = `${t[k]} / ${mg[k]} г`; $(bar).style.width = Math.min(100, mg[k] ? t[k] / mg[k] * 100 : 0) + '%'; };
  setMacro('p', '#mp', '#mpb'); setMacro('f', '#mf', '#mfb'); setMacro('c', '#mc', '#mcb');
  renderPlan();
}
function renderPlan() {
  const box = $('#today-plan'), items = diary[diaryDate] || [];
  box.innerHTML = MEAL_ORDER.map((meal) => {
    const es = items.filter((e) => e.meal === meal);
    if (!es.length) {
      const budget = Math.round(goalKcal * (MEAL_SHARE[meal] || 0));
      return `<div class="slot empty" data-meal="${meal}">
        <div class="slot-plus">+</div>
        <div class="slot-main"><span class="eyebrow">${MEALS[meal].label}</span>
          <div class="slot-title">Ещё не выбран</div>
          <div class="slot-sub accent">${budget} ккал в запасе · подобрать →</div></div></div>`;
    }
    return `<div class="slot"><span class="eyebrow">${MEALS[meal].label}</span>` + es.map((e) => {
      const kcal = Math.round(e.base.kcal * e.portions);
      return `<div class="slot-filled" data-id="${e.id}" style="margin-top:8px">
        <div class="slot-main">
          <div class="slot-title" data-open="${esc(e.rid || '')}">${esc(e.title)}</div>
          <div class="slot-kbju">${kcal} ккал · Б ${Math.round(e.base.p * e.portions)} · Ж ${Math.round(e.base.f * e.portions)} · У ${Math.round(e.base.c * e.portions)}</div>
        </div>
        <div class="stepper"><button data-step="-1">−</button><span>×${e.portions}</span><button data-step="1">+</button></div>
        <button class="slot-check" data-del="1" aria-label="Удалить">✕</button>
      </div>`;
    }).join('') + `</div>`;
  }).join('');
}
function onPlanClick(e) {
  const empty = e.target.closest('.slot.empty');
  if (empty) { const meal = empty.dataset.meal; switchTab('fridge'); setFridgeMeal(meal); return; }
  const row = e.target.closest('.slot-filled'); if (!row) return;
  const id = row.dataset.id;
  if (e.target.dataset.del) { diary[diaryDate] = (diary[diaryDate] || []).filter((x) => x.id !== id); save(STORE.diary, diary); return renderToday(); }
  if (e.target.dataset.step) { changePortions(id, +e.target.dataset.step * 0.5); return; }
  const open = e.target.closest('[data-open]'); if (open && open.dataset.open) openRecipe(open.dataset.open);
}
function changePortions(id, delta) {
  const e = (diary[diaryDate] || []).find((x) => x.id === id); if (!e) return;
  e.portions = Math.max(0.5, Math.round((e.portions + delta) * 2) / 2); save(STORE.diary, diary); renderToday();
}
function addToDiary(recipe) {
  const per = nutritionOf(recipe).per, day = diary[diaryDate] || (diary[diaryDate] = []);
  day.push({ id: uid(), rid: recipe.id, title: recipe.title, meal: recipe.meal, base: { kcal: per.kcal, p: per.p, f: per.f, c: per.c }, portions: 1 });
  save(STORE.diary, diary); renderToday(); toast(`✓ «${recipe.title}» — в дневник`);
}

// ============================================================================
// ХОЛОДИЛЬНИК
// ============================================================================
function setFridgeMeal(meal) { $$('#meal-filter .seg').forEach((s) => s.classList.toggle('active', s.dataset.meal === meal)); updateFindBtn(); }
function selectedMeals() { const m = $('#meal-filter .seg.active')?.dataset.meal; return m ? [m] : []; }
function bindFridge() {
  $('#fridge-search').addEventListener('input', debounce(renderFridge, 130));
  $('#meal-filter').addEventListener('click', (e) => { const s = e.target.closest('.seg'); if (!s) return; $$('#meal-filter .seg').forEach((x) => x.classList.remove('active')); s.classList.add('active'); updateFindBtn(); });
  $('#fridge-clear').addEventListener('click', () => { fridge = []; save(STORE.fridge, fridge); renderFridge(); updateFindBtn(); });
  $('#fridge-picker').addEventListener('click', onFridgePick);
  $('#fridge-find').addEventListener('click', showFridgeResults);
  $('#fridge-results').addEventListener('click', onResultsClick);
}
function toggleShelf(id) {
  if (fridge.includes(id)) fridge = fridge.filter((x) => x !== id);
  else { fridge.push(id); freq[id] = (freq[id] || 0) + 1; save(STORE.freq, freq); }
  save(STORE.fridge, fridge); renderFridge(); updateFindBtn();
}
function onFridgePick(e) {
  const chipX = e.target.closest('.chip-x'); if (chipX) return toggleShelf(chipX.dataset.id);
  const chip = e.target.closest('.chip-soft'); if (chip) return toggleShelf(chip.dataset.id);
  const catRow = e.target.closest('.cat-row'); if (catRow) { catRow.classList.toggle('open'); catRow.nextElementSibling.classList.toggle('open'); }
}
const FREQ_DEFAULT = ['tomato', 'cucumber', 'egg', 'chicken_breast', 'oats', 'greek_yogurt', 'avocado', 'banana'];
function renderFridge() {
  const q = $('#fridge-search').value.trim().toLowerCase(), qWords = toWords(q);
  const chosen = new Set(fridge);
  // счётчик подзаголовка
  $('#fridge-count').textContent = `На полке ${fridge.length} · подходят ${fridgeMatchCount()} рецептов`;
  // На полке
  $('#fridge-shelf').innerHTML = fridge.map((id) => `<button class="chip-x" data-id="${id}">${esc(ING_BY_ID[id]?.name || id)} <span class="x">✕</span></button>`).join('');
  // Обычно бывает у вас
  const freqHead = $('#fridge-freq').previousElementSibling, catsHead = $('#fridge-cats').previousElementSibling;
  if (qWords.length) {
    freqHead.style.display = 'none'; $('#fridge-freq').style.display = 'none';
    catsHead.querySelector('.eyebrow').textContent = 'Найдено';
    const matches = INGREDIENTS.filter(([, name]) => textMatches(name, qWords)).slice(0, 60);
    $('#fridge-cats').className = 'shelf';
    $('#fridge-cats').innerHTML = matches.map(([id, name]) => `<button class="${chosen.has(id) ? 'chip-x' : 'chip-soft'}" data-id="${id}">${esc(name)}${chosen.has(id) ? ' <span class="x">✕</span>' : ''}</button>`).join('') || '<p class="subhead">Ничего не найдено</p>';
  } else {
    freqHead.style.display = ''; $('#fridge-freq').style.display = '';
    catsHead.querySelector('.eyebrow').textContent = 'Все продукты';
    const top = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).filter((id) => !chosen.has(id));
    const list = (top.length ? top : FREQ_DEFAULT.filter((id) => !chosen.has(id))).slice(0, 8);
    $('#fridge-freq').innerHTML = list.map((id) => `<button class="chip-soft" data-id="${id}">${esc(ING_BY_ID[id]?.name || id)}</button>`).join('') || '<p class="subhead" style="color:var(--ink-3)">—</p>';
    // Все продукты — аккордеон по категориям
    $('#fridge-cats').className = 'cat-list';
    $('#fridge-cats').innerHTML = Object.keys(CATEGORIES).map((cat) => {
      const items = INGREDIENTS.filter((x) => x[2] === cat);
      const sel = items.filter((x) => chosen.has(x[0])).length;
      return `<div class="cat-row" data-cat="${cat}"><span class="cat-name">${CATEGORIES[cat]}</span><span class="cat-count">${sel} / ${items.length}</span><span class="cat-chev">›</span></div>
        <div class="cat-body">${items.sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<button class="${chosen.has(id) ? 'chip-x' : 'chip-soft'}" data-id="${id}">${esc(name)}${chosen.has(id) ? ' <span class="x">✕</span>' : ''}</button>`).join('')}</div>`;
    }).join('');
  }
}
function fridgeMatchCount() { const have = new Set(fridge); if (!have.size) return 0; const meals = selectedMeals(); return recipes.filter((r) => (!meals.length || meals.includes(r.meal)) && r.ingredients.some((i) => have.has(i.id))).length; }
function updateFindBtn() { const n = fridgeMatchCount(); $('#fridge-find').textContent = fridge.length ? `Показать ${n} рецептов` : 'Показать рецепты'; $('#fridge-count').textContent = `На полке ${fridge.length} · подходят ${n} рецептов`; }

function rankedFridge() {
  const have = new Set(fridge), meals = selectedMeals();
  return recipes.filter((r) => meals.length === 0 || meals.includes(r.meal)).map((r) => {
    const ids = r.ingredients.map((i) => i.id), matched = ids.filter((id) => have.has(id)), missing = ids.filter((id) => !have.has(id));
    return { r, matched, missing, ratio: matched.length / ids.length };
  }).filter((x) => x.matched.length > 0).sort((a, b) => b.ratio - a.ratio || a.missing.length - b.missing.length || nutritionOf(a.r).per.kcal - nutritionOf(b.r).per.kcal);
}
function showFridgeResults() {
  if (!fridge.length) return toast('Отметьте продукты на полке');
  const scored = rankedFridge(), box = $('#fridge-results');
  $('#fridge-picker').hidden = true; $('#fridge-find').style.display = 'none'; box.hidden = false;
  box.innerHTML = `<button class="results-back">‹ Назад к полке</button><div class="rres">` + (scored.length ? scored.map(({ r, missing, ratio }) => {
    const n = nutritionOf(r).per, pct = Math.round(ratio * 100);
    const miss = missing.length ? `<div class="miss">Докупить: ${missing.map((id) => `<button class="miss-add" data-ing="${id}">+ ${esc(ING_BY_ID[id]?.name || id)}</button>`).join(' ')}</div>` : `<div class="have-all">✓ Всё есть на полке</div>`;
    return `<article class="rcard" data-open="${r.id}"><div class="rcard-photo"><div class="match-pill ${pct === 100 ? 'full' : ''}">${pct}%</div><img src="${recipeImage(r)}" alt="" loading="lazy" decoding="async"></div>
      <div class="rcard-eyebrow eyebrow">${MEALS[r.meal].label} · ${r.time} мин</div><h3 class="serif rcard-title">${esc(r.title)}</h3>
      <div class="rcard-kbju"><b>${n.kcal}</b> ккал · Б ${n.p} · Ж ${n.f} · У ${n.c}</div>${miss}</article>`;
  }).join('') : `<p class="results-empty">Подходящих рецептов нет. Добавьте продукты или новый рецепт.</p>`) + `</div>`;
  window.scrollTo({ top: 0 });
}
function onResultsClick(e) {
  if (e.target.closest('.results-back')) { $('#fridge-results').hidden = true; $('#fridge-picker').hidden = false; $('#fridge-find').style.display = ''; return; }
  const add = e.target.closest('.miss-add'); if (add) { e.stopPropagation(); addToShopping(add.dataset.ing); add.textContent = '✓ в списке'; add.classList.add('added'); add.disabled = true; return; }
  const card = e.target.closest('.rcard'); if (card) openRecipe(card.dataset.open);
}

// ============================================================================
// РЕЦЕПТЫ
// ============================================================================
function bindRecipes() {
  $('#recipe-search').addEventListener('input', debounce(renderRecipes, 130));
  $('#recipe-meal-filter').addEventListener('click', (e) => { const s = e.target.closest('.seg'); if (!s) return; $$('#recipe-meal-filter .seg').forEach((x) => x.classList.remove('active')); s.classList.add('active'); renderRecipes(); });
  $('#recipe-list').addEventListener('click', (e) => { const c = e.target.closest('.rcard'); if (c) openRecipe(c.dataset.open); });
  $('#recipe-add').addEventListener('click', openAddSheet);
}
// первый тег часто дублирует приём пищи («завтрак») — убираем такие из показа
function cleanTags(r) { const ml = MEALS[r.meal].label.toLowerCase(); return (r.tags || []).filter((t) => t.toLowerCase() !== ml); }

function renderRecipes() {
  const qWords = toWords($('#recipe-search').value.trim());
  const meal = $('#recipe-meal-filter .seg.active')?.dataset.meal || 'all', box = $('#recipe-list');
  const mine = recipes.filter((r) => r.custom).length;
  $('#recipe-total').textContent = `${recipes.length} рецептов · ${mine} ваших`;
  const list = recipes.filter((r) => (meal === 'all' || r.meal === meal) && (!qWords.length || recipeMatches(r, qWords)));
  if (!list.length) { box.innerHTML = `<p class="feed-empty">Ничего не найдено.</p>`; return; }
  box.innerHTML = list.map((r) => {
    const n = nutritionOf(r).per;
    const shown = cleanTags(r), tag = shown[0];
    return `<article class="rcard" data-open="${r.id}">
      <div class="rcard-photo"><div class="time-pill">${r.time} мин</div><img src="${recipeImage(r)}" alt="" loading="lazy" decoding="async"></div>
      <div class="rcard-eyebrow eyebrow">${MEALS[r.meal].label}${tag ? ' · ' + esc(tag) : ''}</div>
      <h3 class="serif rcard-title">${esc(r.title)}</h3>
      <div class="rcard-kbju"><b>${n.kcal}</b> ккал · Б ${n.p} · Ж ${n.f} · У ${n.c}</div>
      <div class="rcard-tags">${shown.slice(1).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </article>`;
  }).join('');
}

// ---- Страница рецепта -------------------------------------------------------
const ICN = {
  back: `<svg viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.6-7-9.5A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7-2.5C19 10.4 12 20 12 20Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  heartFill: `<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-9.5A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7-2.5C19 10.4 12 20 12 20Z" fill="currentColor"/></svg>`,
  dots: `<svg viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>`,
  bag: `<svg viewBox="0 0 24 24" fill="none"><path d="M6.5 8.5h11l-1 11H7.5l-1-11Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.3 8.5V6.8a2.7 2.7 0 0 1 5.4 0v1.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
};
let modalRecipeId = null;
function openRecipe(id) {
  const r = recipes.find((x) => x.id === id); if (!r) return;
  modalRecipeId = id;
  const nut = nutritionOf(r), fav = favorites.includes(id);
  $('#modal-content').innerHTML = `
    <div class="rp-hero"><img src="${recipeImage(r)}" alt="">
      <div class="rp-top">
        <button class="glass-btn" id="rp-back" aria-label="Назад">${ICN.back}</button>
        <div class="right"><button class="glass-btn ${fav ? 'on' : ''}" id="rp-fav" aria-label="Избранное">${fav ? ICN.heartFill : ICN.heart}</button><button class="glass-btn" id="rp-more" aria-label="Ещё">${ICN.dots}</button></div>
      </div></div>
    <div class="rp-body">
      <div class="rp-eyebrow eyebrow">${MEALS[r.meal].label} · ${r.time} мин · ${r.servings} порц.</div>
      <h1 class="serif rp-title">${esc(r.title)}</h1>
      <div class="rp-tags">${cleanTags(r).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="kbju-line">
        <div><b>${nut.per.kcal}</b><span>ккал</span></div><div><b>${nut.per.p}</b><span>белки</span></div>
        <div><b>${nut.per.f}</b><span>жиры</span></div><div><b>${nut.per.c}</b><span>углев.</span></div>
      </div>
      <div class="kbju-sub">На порцию ~${nut.per.weight} г · ${nut.per100.kcal} ккал на 100 г</div>
      <div class="segment rp-seg"><button class="seg active" data-rp="ing">Ингредиенты</button><button class="seg" data-rp="steps">Приготовление</button></div>
      <div id="rp-ing"><ul class="rp-list">${r.ingredients.map((i) => `<li><span>${esc(ING_BY_ID[i.id]?.name || i.id)}</span><span class="g">${i.g} г</span></li>`).join('')}</ul></div>
      <ol class="rp-steps hidden" id="rp-steps">${(r.steps || []).map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="subhead">Шаги не указаны.</li>'}</ol>
    </div>
    <div class="rp-actions">
      <button class="primary" id="rp-diary">Съедено — в дневник</button>
      <button class="sq" id="rp-shop" aria-label="В покупки">${ICN.bag}</button>
      <button class="sq heart" id="rp-health" aria-label="В Здоровье">♥</button>
    </div>`;
  openSheet('#recipe-modal');
  $('#rp-back').onclick = () => closeSheet('#recipe-modal');
  $('#rp-fav').onclick = () => toggleFavorite(id);
  $('#rp-more').onclick = () => openRecipeMenu(r);
  $('#modal-content').querySelector('.rp-seg').onclick = (e) => { const s = e.target.closest('.seg'); if (!s) return; $$('.rp-seg .seg').forEach((x) => x.classList.remove('active')); s.classList.add('active'); $('#rp-ing').classList.toggle('hidden', s.dataset.rp !== 'ing'); $('#rp-steps').classList.toggle('hidden', s.dataset.rp !== 'steps'); };
  $('#rp-diary').onclick = () => { addToDiary(r); $('#rp-diary').textContent = '✓ В дневнике'; };
  $('#rp-shop').onclick = () => { r.ingredients.forEach((i) => addToShopping(i.id, i.g)); toast('✓ Состав — в покупки'); };
  $('#rp-health').onclick = () => { const p = nutritionOf(r).per; logToHealth(p.kcal, p.p, p.f, p.c, r.title); };
}
function toggleFavorite(id) {
  if (favorites.includes(id)) favorites = favorites.filter((x) => x !== id); else favorites.push(id);
  save(STORE.fav, favorites);
  const on = favorites.includes(id), btn = $('#rp-fav'); if (btn) { btn.classList.toggle('on', on); btn.innerHTML = on ? ICN.heartFill : ICN.heart; }
}
function openRecipeMenu(r) {
  openActionSheet([
    { label: 'Съедено — в дневник', fn: () => addToDiary(r) },
    { label: 'Добавить состав в покупки', fn: () => { r.ingredients.forEach((i) => addToShopping(i.id, i.g)); toast('✓ В покупки'); } },
    { label: 'Удалить рецепт', warn: true, fn: () => { if (!confirm('Удалить рецепт?')) return; deleteRecipe(r.id); closeSheet('#recipe-modal'); } },
  ]);
}
function deleteRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (r && (r.bank || String(id).startsWith('bk'))) { const d = new Set(load(STORE.deleted, [])); d.add(id); save(STORE.deleted, [...d]); }
  recipes = recipes.filter((x) => x.id !== id); save(STORE.recipes, recipes); _searchIdx.delete(id);
  renderRecipes(); renderToday(); toast('Рецепт удалён');
}

// ============================================================================
// ШТОРКА «НОВЫЙ РЕЦЕПТ»
// ============================================================================
function bindAddSheet() {
  $('#recipe-add') && ($('#add-cancel').addEventListener('click', () => closeSheet('#add-sheet')));
  $('#add-save').addEventListener('click', saveNewRecipe);
  $('#add-form').addEventListener('submit', saveNewRecipe);
  $('#add-ing-btn').addEventListener('click', addDraftIngredient);
  $('#add-ing-grams').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDraftIngredient(); } });
  $('#servings').addEventListener('input', renderDraftNutrition);
  $('#photo-pick').addEventListener('click', () => $('#recipe-photo').click());
  $('#recipe-photo').addEventListener('change', handlePhoto);
  $('#draft-ings').addEventListener('click', (e) => { const d = e.target.closest('.draft-del'); if (d) { draftIngredients.splice(+d.dataset.idx, 1); renderDraft(); } });
}
function openAddSheet() {
  $('#add-form').reset(); draftIngredients = []; draftPhoto = null;
  $('#photo-preview').hidden = true; $('#photo-pick').hidden = false; renderDraft(); openSheet('#add-sheet');
}
function renderAddOptions() {
  const groups = {}; for (const [id, name, cat] of INGREDIENTS) (groups[cat] ||= []).push([id, name]);
  $('#add-ing-select').innerHTML = Object.entries(groups).map(([cat, items]) => `<optgroup label="${CATEGORIES[cat] || cat}">` + items.sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('') + `</optgroup>`).join('');
}
function addDraftIngredient() {
  const id = $('#add-ing-select').value, g = parseFloat($('#add-ing-grams').value);
  if (!id || !g || g <= 0) return toast('Укажите ингредиент и граммы');
  const ex = draftIngredients.find((i) => i.id === id); if (ex) ex.g += g; else draftIngredients.push({ id, g });
  $('#add-ing-grams').value = ''; renderDraft();
}
function renderDraft() {
  const box = $('#draft-ings');
  box.innerHTML = draftIngredients.length ? draftIngredients.map((i, idx) => `<div class="draft-row"><span>${esc(ING_BY_ID[i.id]?.name || i.id)}</span><span class="draft-g">${i.g} г</span><button type="button" class="draft-del" data-idx="${idx}">✕</button></div>`).join('') : `<p class="subhead" style="color:var(--ink-3)">Пока пусто — добавьте ингредиенты выше.</p>`;
  renderDraftNutrition();
}
function renderDraftNutrition() {
  const s = Math.max(1, parseInt($('#servings').value) || 1), n = computeNutrition({ ingredients: draftIngredients, servings: s });
  $('#draft-kbju').innerHTML = `<div><b class="serif">${n.per.kcal}</b><span>ккал</span></div><div><b class="serif">${n.per.p}</b><span>белки</span></div><div><b class="serif">${n.per.f}</b><span>жиры</span></div><div><b class="serif">${n.per.c}</b><span>углев.</span></div>`;
  $('#draft-kbju-note').textContent = draftIngredients.length ? `КБЖУ на порцию · ~${n.per.weight} г` : 'КБЖУ на порцию';
}
function handlePhoto(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { const img = new Image(); img.onload = () => { const max = 800; let { width, height } = img; if (width > max || height > max) { const k = Math.min(max / width, max / height); width = Math.round(width * k); height = Math.round(height * k); } const c = document.createElement('canvas'); c.width = width; c.height = height; c.getContext('2d').drawImage(img, 0, 0, width, height); draftPhoto = c.toDataURL('image/jpeg', 0.8); $('#photo-preview').src = draftPhoto; $('#photo-preview').hidden = false; $('#photo-pick').hidden = true; }; img.src = reader.result; };
  reader.readAsDataURL(file);
}
function saveNewRecipe(e) {
  e.preventDefault();
  const title = $('#recipe-title').value.trim(); if (!title) return toast('Введите название');
  if (!draftIngredients.length) return toast('Добавьте ингредиент');
  const recipe = { id: uid(), title, meal: $('#recipe-meal').value, time: Math.max(1, parseInt($('#recipe-time').value) || 15), servings: Math.max(1, parseInt($('#servings').value) || 1), emoji: MEALS[$('#recipe-meal').value].emoji, ingredients: draftIngredients.map((i) => ({ ...i })), steps: $('#recipe-steps').value.split('\n').map((s) => s.trim()).filter(Boolean), tags: $('#recipe-tags').value.split(',').map((s) => s.trim()).filter(Boolean), image: draftPhoto || null, custom: true };
  recipes.unshift(recipe);
  try { save(STORE.recipes, recipes); } catch { recipes.shift(); return toast('Недостаточно места — фото меньше'); }
  closeSheet('#add-sheet');
  $('#recipe-search').value = '';
  $$('#recipe-meal-filter .seg').forEach((s) => s.classList.toggle('active', s.dataset.meal === 'all'));
  renderRecipes(); switchTab('recipes'); toast('✓ Рецепт сохранён');
}

// ============================================================================
// ПОКУПКИ
// ============================================================================
function bindShopping() {
  $('#shop-manual').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addManualShop(); } });
  $('#shop-add-btn').addEventListener('click', addManualShop);
  $('#shop-clear-checked').addEventListener('click', () => { shopping = shopping.filter((s) => !s.checked); save(STORE.shopping, shopping); renderShopping(); });
  $('#shop-clear-all').addEventListener('click', () => { if (shopping.length && confirm('Очистить весь список?')) { shopping = []; save(STORE.shopping, shopping); renderShopping(); } });
  $('#shopping-list').addEventListener('click', (e) => { const it = e.target.closest('.shop-item'); if (!it) return; const idx = +it.dataset.idx; shopping[idx].checked = !shopping[idx].checked; save(STORE.shopping, shopping); renderShopping(); });
}
function addManualShop() { const v = $('#shop-manual').value.trim(); if (!v) return; shopping.push({ id: 'm_' + uid(), name: v, cat: 'other', checked: false, manual: true }); $('#shop-manual').value = ''; save(STORE.shopping, shopping); renderShopping(); }
function addToShopping(ingId, g) {
  const ing = ING_BY_ID[ingId], ex = shopping.find((s) => s.id === ingId);
  if (ex) { if (g) ex.g = (ex.g || 0) + g; ex.checked = false; } else shopping.push({ id: ingId, name: ing?.name || ingId, cat: ing?.cat || 'other', checked: false, g: g || 0 });
  save(STORE.shopping, shopping); renderShopping();
}
function renderShopping() {
  updateShopBadge();
  const total = shopping.length, done = shopping.filter((s) => s.checked).length;
  $('#shop-bar').style.width = total ? done / total * 100 + '%' : '0%';
  $('#shop-progress-txt').textContent = total ? `${done} из ${total} куплено` : 'Список пуст';
  const box = $('#shopping-list');
  if (!total) { box.innerHTML = `<p class="feed-empty">Список пуст. Добавляйте ингредиенты из рецептов.</p>`; return; }
  const groups = {}; shopping.forEach((s) => (groups[s.cat] ||= []).push(s));
  box.innerHTML = Object.entries(groups).map(([cat, items]) => `<div class="shop-group"><h4>${(CATEGORIES[cat] || 'Прочее').replace(/^\S+\s/, '')}</h4><div class="shop-group-items">${items.map((s) => { const idx = shopping.indexOf(s); const amount = s.g ? `<span class="shop-g">${Math.round(s.g)} г</span>` : ''; return `<div class="shop-item ${s.checked ? 'done' : ''}" data-idx="${idx}"><span class="check">${s.checked ? '✓' : ''}</span><span class="shop-name">${esc(s.name)}</span>${amount}</div>`; }).join('')}</div></div>`).join('');
}
function updateShopBadge() { const n = shopping.filter((s) => !s.checked).length, b = $('#shop-badge'); b.textContent = n; b.style.display = n ? 'flex' : 'none'; }

// ============================================================================
// НАСТРОЙКИ
// ============================================================================
function bindSettings() {
  $('#settings-close').addEventListener('click', () => closeSheet('#settings-sheet'));
  const g = getMacroGoals();
  const gi = $('#goal-input'), gp = $('#goal-p'), gf = $('#goal-f'), gc = $('#goal-c'), si = $('#shortcut-input');
  const saveGoals = debounce(() => {
    goalKcal = Math.max(0, parseInt(gi.value) || 0) || DEFAULT_GOAL; save(STORE.goal, goalKcal);
    macroGoals = { p: parseInt(gp.value) || 0, f: parseInt(gf.value) || 0, c: parseInt(gc.value) || 0 };
    if (macroGoals.p || macroGoals.f || macroGoals.c) save(STORE.macro, macroGoals); renderToday();
  }, 250);
  [gi, gp, gf, gc].forEach((el) => el.addEventListener('input', saveGoals));
  si.addEventListener('input', debounce(() => { shortcutName = si.value.trim() || DEFAULT_SHORTCUT; save(STORE.shortcut, shortcutName); }, 250));
  $('#export-btn').addEventListener('click', exportRecipes);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', importRecipes);
  $('#update-base').addEventListener('click', () => { const n = reconcileBank(); renderRecipes(); toast(n ? `✓ Добавлено рецептов: ${n}` : `✓ База актуальна: ${recipes.length}`); });
}
function openSettings() {
  const g = getMacroGoals();
  $('#goal-input').value = goalKcal || ''; $('#goal-p').value = g.p; $('#goal-f').value = g.f; $('#goal-c').value = g.c;
  $('#shortcut-input').value = shortcutName || ''; openSheet('#settings-sheet');
}

// ---- Импорт / экспорт -------------------------------------------------------
function exportRecipes() {
  if (!recipes.length) return toast('Нет рецептов');
  const blob = new Blob([JSON.stringify({ app: 'pp-recipes', version: 1, exported: new Date().toISOString(), recipes }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `pp-recipes-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`✓ Экспортировано: ${recipes.length}`);
}
function isValidRecipe(r) { return r && typeof r.title === 'string' && r.title.trim() && Array.isArray(r.ingredients) && r.ingredients.every((i) => i && typeof i.id === 'string' && typeof i.g === 'number') && Object.prototype.hasOwnProperty.call(MEALS, r.meal); }
function importRecipes(e) {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data; try { data = JSON.parse(reader.result); } catch { return toast('Файл не JSON'); }
    const incoming = Array.isArray(data) ? data : (data && Array.isArray(data.recipes) ? data.recipes : null);
    if (!incoming) return toast('Нет рецептов в файле');
    const existing = new Set(recipes.map((r) => r.id)); let added = 0, dup = 0, bad = 0;
    for (const raw of incoming) {
      if (!isValidRecipe(raw)) { bad++; continue; }
      if (existing.has(raw.id) || recipes.some((r) => r.title.trim().toLowerCase() === raw.title.trim().toLowerCase() && r.meal === raw.meal)) { dup++; continue; }
      const recipe = { id: uid(), title: String(raw.title).trim(), meal: raw.meal, time: Math.max(1, parseInt(raw.time) || 15), servings: Math.max(1, parseInt(raw.servings) || 1), emoji: (raw.emoji && String(raw.emoji).slice(0, 4)) || MEALS[raw.meal].emoji, ingredients: raw.ingredients.filter((i) => typeof i.id === 'string' && i.g > 0).map((i) => ({ id: i.id, g: Math.round(i.g) })), steps: Array.isArray(raw.steps) ? raw.steps.map(String) : [], tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [], image: typeof raw.image === 'string' && raw.image.startsWith('data:') ? raw.image : null, custom: true };
      if (raw.nutrition && typeof raw.nutrition.kcal === 'number') recipe.nutrition = { kcal: +raw.nutrition.kcal, p: +raw.nutrition.p || 0, f: +raw.nutrition.f || 0, c: +raw.nutrition.c || 0 };
      recipes.unshift(recipe); existing.add(recipe.id); added++;
    }
    if (!added) return toast(dup ? 'Все рецепты уже есть' : 'Подходящих нет');
    try { save(STORE.recipes, recipes); } catch { recipes.splice(0, added); return toast('Недостаточно места'); }
    renderRecipes(); closeSheet('#settings-sheet'); switchTab('recipes'); toast(`✓ Импортировано: ${added}`);
  };
  reader.readAsText(file);
}

// ---- Apple Health via Shortcuts ---------------------------------------------
function logToHealth(kcal, p, f, c, label) {
  const payload = [Math.round(kcal), Math.round(p), Math.round(f), Math.round(c)].join(',');
  const url = `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName)}&input=text&text=${encodeURIComponent(payload)}`;
  const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  toast(`♥ ${label || 'Отправлено'} → Здоровье (${Math.round(kcal)} ккал)`);
}

// ---- Шторки / action sheet --------------------------------------------------
function openSheet(sel) { $(sel).classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeSheet(sel) { $(sel).classList.remove('open'); if (!$$('.sheet.open').length) document.body.style.overflow = ''; }
function openActionSheet(items) {
  $('#action-content').innerHTML = `<div class="action-group">${items.map((it, i) => `<button class="action-item ${it.warn ? 'warn' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('')}</div><button class="action-cancel" data-cancel>Отмена</button>`;
  $('#action-content').onclick = (e) => {
    if (e.target.dataset.cancel !== undefined) return closeSheet('#action-sheet');
    const b = e.target.closest('.action-item'); if (!b) return; closeSheet('#action-sheet'); const it = items[+b.dataset.i]; it && it.fn && it.fn();
  };
  openSheet('#action-sheet');
}
function bindGlobal() {
  $$('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeSheet('#' + s.id); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.sheet.open').forEach((s) => closeSheet('#' + s.id)); });
}

// ---- Тост -------------------------------------------------------------------
let toastTimer;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200); }

// ---- Service Worker ---------------------------------------------------------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => { reg.update(); reg.addEventListener('updatefound', () => { const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) nw.postMessage('skip-waiting'); }); }); }).catch(() => {});
  let skipFirst = !navigator.serviceWorker.controller, reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (skipFirst) { skipFirst = false; return; } if (reloaded) return; reloaded = true; window.location.reload(); });
}
async function checkAppUpdate() { if (!('serviceWorker' in navigator)) return; try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch {} }

// ---- Pull-to-refresh --------------------------------------------------------
function bindPullToRefresh() {
  const ptr = $('#ptr'); if (!ptr) return;
  const HID = -56, HOLD = 12, TRIG = 60, MAX = 92; let startY = 0, pulling = false, armed = false, busy = false;
  const scrollTop = () => window.scrollY || document.documentElement.scrollTop || 0;
  const blocked = (t) => busy || $$('.sheet.open').length || (t.closest && t.closest('.ing-cloud,.segment,.sheet-card,.cat-body') && t.closest('.ing-cloud,.segment,.sheet-card,.cat-body').scrollTop > 0);
  const place = (shown, text, spin) => { ptr.style.transform = `translateY(${HID + shown}px)`; if (text != null) ptr.querySelector('.ptr-text').textContent = text; ptr.classList.toggle('spin', !!spin); };
  window.addEventListener('touchstart', (e) => { if (scrollTop() > 0 || blocked(e.target)) { pulling = false; return; } startY = e.touches[0].clientY; pulling = true; armed = false; ptr.style.transition = 'none'; }, { passive: true });
  window.addEventListener('touchmove', (e) => { if (!pulling) return; const dy = e.touches[0].clientY - startY; if (dy <= 0 || scrollTop() > 0) { pulling = false; ptr.style.transition = 'transform .25s'; place(0); return; } e.preventDefault(); const shown = Math.min(dy * 0.5, MAX); armed = shown >= TRIG; place(shown, armed ? 'Отпустите — обновить базу' : 'Потяните вниз ↓', false); }, { passive: false });
  window.addEventListener('touchend', async () => { if (!pulling) return; pulling = false; ptr.style.transition = 'transform .28s'; if (!armed) return place(0); busy = true; place(HOLD - HID, 'Обновление базы…', true); const added = reconcileBank(); renderRecipes(); renderToday(); await checkAppUpdate(); place(HOLD - HID, added ? `Добавлено: ${added}` : 'База актуальна', false); setTimeout(() => { place(0); busy = false; toast(added ? `✓ База обновлена: +${added} (всего ${recipes.length})` : `✓ База актуальна: ${recipes.length} рецептов`); }, 700); });
}

document.addEventListener('DOMContentLoaded', init);
