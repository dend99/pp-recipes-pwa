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
};

// ---- Состояние --------------------------------------------------------------
let recipes = [];        // все рецепты (seed + пользовательские)
let shopping = [];       // [{id, name, cat, checked, manual, g}]
let fridge = [];         // ids ингредиентов «в холодильнике»
let draftIngredients = []; // черновик при добавлении рецепта: [{id, g}]

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

// ---- Картинка-заглушка (SVG, оффлайн) --------------------------------------
function placeholderImage(recipe) {
  const palettes = [
    ['#34d399', '#059669'], ['#fbbf24', '#d97706'], ['#60a5fa', '#2563eb'],
    ['#f472b6', '#db2777'], ['#a78bfa', '#7c3aed'], ['#fb7185', '#e11d48'],
  ];
  let h = 0; for (const ch of recipe.id) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  const [c1, c2] = palettes[h % palettes.length];
  const emoji = recipe.emoji || MEALS[recipe.meal]?.emoji || '🍽️';
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='260'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/>` +
    `</linearGradient></defs>` +
    `<rect width='400' height='260' fill='url(#g)'/>` +
    `<text x='200' y='150' font-size='110' text-anchor='middle'>${emoji}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
const recipeImage = (r) => r.image || placeholderImage(r);

// ============================================================================
// Инициализация
// ============================================================================
function init() {
  const userRecipes = load(STORE.recipes, null);
  recipes = userRecipes ? userRecipes : SEED_RECIPES.map((r) => ({ ...r }));
  if (!userRecipes) save(STORE.recipes, recipes);
  shopping = load(STORE.shopping, []);
  fridge = load(STORE.fridge, []);

  bindTabs();
  bindFridge();
  bindRecipes();
  bindAddForm();
  bindShopping();

  renderFridgeIngredients();
  renderRecipes();
  renderShopping();
  renderAddIngredientOptions();

  registerSW();
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
  $('#fridge-search').addEventListener('input', renderFridgeIngredients);
  $('#fridge-find').addEventListener('click', findRecipes);
  $('#fridge-clear').addEventListener('click', () => {
    fridge = []; save(STORE.fridge, fridge);
    renderFridgeIngredients(); $('#fridge-results').innerHTML = '';
  });
  $$('#meal-filter .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
    });
  });
}

function renderFridgeIngredients() {
  const q = $('#fridge-search').value.trim().toLowerCase();
  const box = $('#fridge-ingredients');
  const chosen = new Set(fridge);
  const list = INGREDIENTS
    .filter(([, name]) => !q || name.toLowerCase().includes(q))
    .sort((a, b) => a[2].localeCompare(b[2]));

  box.innerHTML = list.map(([id, name, cat]) => {
    const on = chosen.has(id);
    return `<button class="ing-chip ${on ? 'on' : ''}" data-id="${id}">` +
      `${on ? '✓ ' : ''}${esc(name)}</button>`;
  }).join('') || `<p class="muted">Ничего не найдено</p>`;

  $$('.ing-chip', box).forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if (fridge.includes(id)) fridge = fridge.filter((x) => x !== id);
    else fridge.push(id);
    save(STORE.fridge, fridge);
    renderFridgeIngredients();
    $('#fridge-count').textContent = fridge.length
      ? `Выбрано: ${fridge.length}` : '';
  }));
  $('#fridge-count').textContent = fridge.length ? `Выбрано: ${fridge.length}` : '';
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
      computeNutrition(a.r).per.kcal - computeNutrition(b.r).per.kcal);

  if (scored.length === 0) {
    box.innerHTML = `<p class="muted">Подходящих рецептов нет. Добавьте ингредиенты или новый рецепт.</p>`;
    return;
  }

  box.innerHTML = `<h3 class="results-title">Нашлось рецептов: ${scored.length}</h3>` +
    scored.map(({ r, missing, ratio }) => {
      const n = computeNutrition(r).per;
      const pct = Math.round(ratio * 100);
      const missText = missing.length
        ? `<div class="miss">Докупить: ${missing.map((id) =>
            `<button class="miss-add" data-ing="${id}">+ ${esc(ING_BY_ID[id]?.name || id)}</button>`).join(' ')}</div>`
        : `<div class="have-all">✓ Всё есть!</div>`;
      return `<article class="rcard" data-open="${r.id}">
        <div class="rcard-badge ${pct === 100 ? 'full' : ''}">${pct}%</div>
        <img class="rcard-img" src="${recipeImage(r)}" alt="">
        <div class="rcard-body">
          <div class="rcard-meal">${MEALS[r.meal].emoji} ${MEALS[r.meal].label} · ⏱ ${r.time} мин</div>
          <h4>${esc(r.title)}</h4>
          <div class="kbju-mini">${n.kcal} ккал · Б ${n.p} · Ж ${n.f} · У ${n.c}</div>
          ${missText}
        </div>
      </article>`;
    }).join('');

  bindCardOpen(box);
  $$('.miss-add', box).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    addToShopping(b.dataset.ing);
    b.textContent = '✓ в списке'; b.classList.add('added'); b.disabled = true;
  }));
}

// ============================================================================
// Вкладка «Рецепты» — просмотр, поиск по ингредиентам, открытие карточки
// ============================================================================
function bindRecipes() {
  $('#recipe-search').addEventListener('input', renderRecipes);
  $$('#recipe-meal-filter .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#recipe-meal-filter .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderRecipes();
    });
  });
}

function renderRecipes() {
  const q = $('#recipe-search').value.trim().toLowerCase();
  const meal = $('#recipe-meal-filter .chip.active')?.dataset.meal || 'all';
  const box = $('#recipe-list');

  const filtered = recipes.filter((r) => {
    if (meal !== 'all' && r.meal !== meal) return false;
    if (!q) return true;
    // поиск по названию, тегам и ингредиентам
    if (r.title.toLowerCase().includes(q)) return true;
    if ((r.tags || []).some((t) => t.toLowerCase().includes(q))) return true;
    return r.ingredients.some((i) =>
      (ING_BY_ID[i.id]?.name || '').toLowerCase().includes(q));
  });

  $('#recipe-total').textContent = `${recipes.length} рецептов в базе`;

  if (filtered.length === 0) {
    box.innerHTML = `<p class="muted">Ничего не найдено. Попробуйте другой запрос.</p>`;
    return;
  }

  box.innerHTML = filtered.map((r) => {
    const n = computeNutrition(r).per;
    return `<article class="rcard" data-open="${r.id}">
      <img class="rcard-img" src="${recipeImage(r)}" alt="">
      <div class="rcard-body">
        <div class="rcard-meal">${MEALS[r.meal].emoji} ${MEALS[r.meal].label} · ⏱ ${r.time} мин · 🍽 ${r.servings} порц.</div>
        <h4>${esc(r.title)}</h4>
        <div class="kbju-mini">${n.kcal} ккал · Б ${n.p} · Ж ${n.f} · У ${n.c}</div>
        <div class="rcard-tags">${(r.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      </div>
    </article>`;
  }).join('');

  bindCardOpen(box);
}

function bindCardOpen(root) {
  $$('.rcard', root).forEach((card) =>
    card.addEventListener('click', () => openRecipe(card.dataset.open)));
}

// ---- Модальное окно рецепта -------------------------------------------------
function openRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  const nut = computeNutrition(r);
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

      ${r.custom ? `<button class="btn btn-danger" id="modal-delete">🗑 Удалить рецепт</button>` : ''}
    </div>`;

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  $('#modal-add-shopping').addEventListener('click', () => {
    r.ingredients.forEach((i) => addToShopping(i.id, i.g));
    $('#modal-add-shopping').textContent = '✓ Добавлено в покупки';
    $('#modal-add-shopping').disabled = true;
  });
  const del = $('#modal-delete');
  if (del) del.addEventListener('click', () => {
    if (confirm('Удалить этот рецепт?')) {
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

// ---- Тосты ------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---- Service Worker ---------------------------------------------------------
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
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
