/**
 * Extension Arranger
 * - Extensions 패널의 칸(확장)을 잡고 끌어서 왼쪽/오른쪽 컬럼 어디로든 옮기고
 * - 덜 보는 확장들을 접을 수 있는 그룹으로 묶고
 * - 자주 쓰는 확장 이름 왼쪽에 Font Awesome 즐겨찾기 아이콘을 표시한다.
 * - Regex 확장의 스크립트(Global / Preset / Scoped)도 그룹으로 묶어 정리할 수 있다.
 */
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'ext_favorites_sorter'; // (기존 저장 데이터 호환을 위해 키 유지)
const COL_IDS = ['extensions_settings', 'extensions_settings2']; // [왼쪽, 오른쪽]
const COL_SEL = COL_IDS.map(id => `#${id}`).join(', ');

const DEFAULTS = {
    // 컬럼별 배치. 항목은 확장 key 또는 그룹 토큰("g:<id>")
    layout: { left: [], right: [] },
    // 그룹: { id: { name, items: [확장 key...] } }  (펼침 상태는 저장하지 않음)
    groups: {},
    items: {},                         // { key: { fav, icon, color } }
    // Regex 스크립트 그룹: { id: { name, type: 'global'|'preset'|'scoped', items: [스크립트 id...] } }
    rgroups: {},
    // Regex 목록별 배치 (스크립트 id 또는 그룹 토큰 "g:<id>") = 화면 순서 = 실행 순서
    rlayout: { global: [], preset: [], scoped: [] },
    defaultIcon: 'fa-solid fa-star',   // 기본 즐겨찾기 아이콘
    defaultColor: '#ffc107',           // 기본 즐겨찾기 색상
    iconSize: 0.95,                    // 즐겨찾기 아이콘 크기 (em)
    newPlacement: 'keep',              // 새 확장 배치: keep | left | right | balance
};

const PRESET_ICONS = [
    'fa-solid fa-star', 'fa-solid fa-heart', 'fa-solid fa-bolt', 'fa-solid fa-fire',
    'fa-solid fa-bookmark', 'fa-solid fa-crown', 'fa-solid fa-gem', 'fa-solid fa-thumbtack',
    'fa-solid fa-flag', 'fa-solid fa-circle-check', 'fa-solid fa-wand-magic-sparkles', 'fa-solid fa-diamond',
];

const TOUCH_HOLD_MS = 250;   // 터치는 이만큼 꾹 눌러야 드래그 시작
const MOUSE_THRESHOLD = 4;   // 마우스는 이만큼 움직이면 드래그 시작

// 같은 확장이 두 번 로드돼도 한 쪽만 동작하게 (이벤트가 두 번 처리돼 클릭이 상쇄되는 것 방지)
const ACTIVE = !window.__stfavArranger;
window.__stfavArranger = true;
console.log(`[Extension Arranger] ${ACTIVE ? '로드됨' : '중복 로드 감지 → 이 사본은 동작하지 않음'}:`, import.meta.url);

let editMode = false;
let pending = null;   // 드래그 시작 대기 중
let dragging = null;  // 드래그 중
let observer = null;
let refreshTimer = null;
let lastDragEnd = 0;       // 드래그 직후의 클릭(접기/펼치기 오동작) 방지용
let dropTarget = null;     // 드래그 중 '안에 넣기' 대상으로 강조 중인 그룹
const openGroups = new Set(); // 지금 펼쳐져 있는 그룹 id (저장 안 함 → 새로고침하면 전부 닫힘)

/* ------------------------------------------------------------------ */
/* 설정                                                                */
/* ------------------------------------------------------------------ */
function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(DEFAULTS);
    }
    const s = extension_settings[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!(k in s)) s[k] = structuredClone(v);
    }
    // 구버전 마이그레이션 (단일 order 배열 → 컬럼별 layout)
    if (Array.isArray(s.order)) {
        if (s.order.length && !s.layout.left.length && !s.layout.right.length) {
            const half = Math.ceil(s.order.length / 2);
            s.layout = { left: s.order.slice(0, half), right: s.order.slice(half) };
        }
        delete s.order;
    }
    return s;
}

function getItemData(key) {
    return getSettings().items[key] || {};
}

function setItemData(key, patch) {
    const s = getSettings();
    s.items[key] = { ...(s.items[key] || {}), ...patch };
    saveSettingsDebounced();
}

/** "fa-heart", "heart", '<i class="fa-solid fa-heart"></i>' 등을 정리해서 클래스 문자열로 */
function parseIcon(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    const m = s.match(/class\s*=\s*["']([^"']+)["']/i);
    if (m) s = m[1];
    s = s.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const parts = s.split(' ');
    const hasStyle = parts.some(p => /^(fa|fas|far|fab|fa-solid|fa-regular|fa-brands)$/.test(p));
    if (!hasStyle) {
        if (parts.length === 1 && !parts[0].startsWith('fa-')) return `fa-solid fa-${parts[0]}`;
        return `fa-solid ${s}`;
    }
    return s;
}

/* ------------------------------------------------------------------ */
/* DOM 헬퍼                                                            */
/* ------------------------------------------------------------------ */
const getColumns = () => COL_IDS.map(id => document.getElementById(id)).filter(Boolean);
const isGroupEl = el => !!el?.classList?.contains('stfav-group');
const isItem = el => el?.nodeType === 1 && !isGroupEl(el) && !!el.querySelector?.('.inline-drawer-toggle');
const slotsOf = col => [...col.children].filter(c => isItem(c) || isGroupEl(c));
const groupBody = gel => gel.querySelector(':scope > .stfav-group-body');
/** 그룹 본문의 직접 자식 (확장 + 하위 그룹) */
const groupSlots = gel => [...groupBody(gel).children].filter(c => isItem(c) || isGroupEl(c));
/** container 안(하위 그룹 포함)의 모든 확장 칸 */
const collectItems = container => [...container.children].flatMap(ch =>
    isGroupEl(ch) ? collectItems(groupBody(ch)) : isItem(ch) ? [ch] : []);
/** 그룹 안의 모든 확장 (하위 그룹 안까지 포함) */
const groupItems = gel => collectItems(groupBody(gel));
/** 다른 그룹 안에 들어 있는 하위 그룹인지 */
const isNestedGroup = gel => !!gel.parentElement?.closest('.stfav-group');

/** 컬럼 직속 + 그룹(하위 그룹 포함) 안에 있는 모든 확장 칸 */
const getItems = () => getColumns().flatMap(collectItems);

/** 저장된 그룹 데이터에서 유효한 하위 그룹 관계만 추림 (childId → parentId, 최대 2단계) */
function nestedGroupMap(groups) {
    const map = new Map();
    for (const [pid, g] of Object.entries(groups)) {
        for (const t of g.items || []) {
            if (!t.startsWith('g:')) continue;
            const cid = t.slice(2);
            if (groups[cid] && cid !== pid && !map.has(cid)) map.set(cid, pid);
        }
    }
    // 부모가 이미 하위 그룹이면 3단계가 되므로 무시 (그 그룹은 맨 위로 나옴)
    for (const [cid, pid] of [...map]) if (map.has(pid)) map.delete(cid);
    return map;
}

/** 컬럼 또는 그룹 본문의 직접 자식(= 칸 하나)을 찾아준다 */
function findItem(el) {
    let n = el;
    while (n && n.parentElement) {
        const p = n.parentElement;
        if (COL_IDS.includes(p.id) || p.classList.contains('stfav-group-body')) return n;
        n = p;
    }
    return null;
}

/** container의 직접 자식 중 el을 포함하는 것 */
function childOf(container, el) {
    let n = el;
    while (n && n.parentElement !== container) n = n.parentElement;
    return n || null;
}

function getKey(item) {
    if (item.id) return `id:${item.id}`;
    const toggle = item.querySelector('.inline-drawer-toggle');
    // 표시 이름을 바꿔 둔 경우에도 키는 '원래 이름' 기준으로 유지 (배치/즐겨찾기 데이터가 꼬이지 않게)
    if (toggle?.dataset.stfavKeyName !== undefined) return `t:${toggle.dataset.stfavKeyName}`;
    const b = toggle?.querySelector('b');
    let name = '';
    if (b) {
        for (const n of b.childNodes) {
            if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
                name = n.textContent.trim();
                break;
            }
        }
    }
    if (!name) name = (toggle?.textContent || '').replace(/\s+/g, ' ').trim();
    return `t:${name}`;
}

function getDisplayName(item) {
    return getKey(item).replace(/^(id|t):/, '');
}

/** 확장 헤더에서 이름이 적힌 텍스트 노드를 찾는다 */
function findNameNode(toggle) {
    const root = toggle.querySelector('b') || toggle;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.textContent.trim() && !n.parentElement.closest('.stfav-badge, .stfav-ctrls'))
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    return walker.nextNode();
}

/** 확장란에 보이는 이름만 바꾼다 (실제 확장 이름/파일은 건드리지 않음). 빈 값이면 원래 이름으로 복구 */
function applyAlias(item, toggle, alias) {
    alias = (alias || '').trim();
    const node = findNameNode(toggle);
    if (!node) return;
    if (toggle.dataset.stfavKeyName === undefined) {
        if (!alias) return; // 바꿀 것도 되돌릴 것도 없음
        toggle.dataset.stfavKeyName = getDisplayName(item); // 원래 이름 기억 (키 계산용)
        toggle.dataset.stfavOrigText = node.textContent;    // 복구용
    }
    const next = alias || toggle.dataset.stfavOrigText;
    if (node.textContent !== next) node.textContent = next;
    if (alias) toggle.title = `원래 이름: ${toggle.dataset.stfavKeyName}`;
    else if (toggle.title.startsWith('원래 이름: ')) toggle.removeAttribute('title');
}

/* ------------------------------------------------------------------ */
/* 그룹 DOM                                                            */
/* ------------------------------------------------------------------ */
function ensureGroupEl(id) {
    let gel = document.querySelector(`.stfav-group[data-gid="${id}"]`);
    if (!gel) {
        gel = document.createElement('div');
        gel.className = 'stfav-group';
        gel.dataset.gid = id;
        gel.innerHTML =
            '<div class="stfav-group-header">' +
            '<i class="stfav-group-chevron fa-solid fa-chevron-right"></i>' +
            '<b class="stfav-group-name"></b>' +
            '<span class="stfav-group-count"></span>' +
            '<span class="stfav-gctrls">' +
            '<span class="stfav-gbtn fa-solid fa-folder-plus" data-act="addsub" title="하위 그룹 추가"></span>' +
            '<span class="stfav-gbtn fa-solid fa-pen" data-act="rename" title="그룹 이름 변경"></span>' +
            '<span class="stfav-gbtn fa-solid fa-trash" data-act="delete" title="그룹 삭제 (안의 항목은 밖으로 나와요)"></span>' +
            '</span>' +
            '</div>' +
            '<div class="stfav-group-body"></div>';
    }
    renderGroup(gel);
    return gel;
}

function renderGroup(gel) {
    const g = getSettings().groups[gel.dataset.gid];
    if (!g) return;
    gel.querySelector('.stfav-group-name').textContent = g.name;
    gel.querySelector('.stfav-group-count').textContent = `(${groupItems(gel).length})`;
    const open = openGroups.has(gel.dataset.gid);
    gel.classList.toggle('stfav-collapsed', !open);
    g.collapsed = !open; // 메모리에서만 맞춰 두는 값 (이전 버전 사본이 같은 상태를 보게 함)
    // 하위 그룹 안에는 또 그룹을 만들 수 없음 (최대 2단계)
    const sub = gel.querySelector(':scope > .stfav-group-header [data-act="addsub"]');
    if (sub) sub.style.display = isNestedGroup(gel) ? 'none' : '';
}

/* ------------------------------------------------------------------ */
/* 저장된 배치 적용 (사용자가 놓은 컬럼/그룹/순서를 그대로 복원)        */
/* ------------------------------------------------------------------ */
function applyLayout() {
    const s = getSettings();
    const cols = getColumns();
    if (cols.length < 2) return;
    const groupIds = Object.keys(s.groups);
    if (!s.layout.left.length && !s.layout.right.length && !groupIds.length) return;

    const map = new Map();
    getItems().forEach(el => { const k = getKey(el); if (!map.has(k)) map.set(k, el); });

    const gEls = new Map(groupIds.map(id => [id, ensureGroupEl(id)]));
    const placed = new Set();
    const want = new Map([[cols[0], []], [cols[1], []]]);
    const add = (container, el) => { want.get(container).push(el); placed.add(el); };

    // 1) 그룹 안의 확장 / 하위 그룹 (하위 그룹은 최대 1단계까지)
    const parentOf = nestedGroupMap(s.groups);
    for (const [id, g] of Object.entries(s.groups)) {
        const body = groupBody(gEls.get(id));
        want.set(body, []);
        for (const k of g.items) {
            if (k.startsWith('g:')) {
                const cid = k.slice(2);
                const cel = gEls.get(cid);
                if (cel && parentOf.get(cid) === id && !placed.has(cel)) add(body, cel);
                continue;
            }
            const el = map.get(k);
            if (el && !placed.has(el)) add(body, el);
        }
    }

    // 2) 컬럼 배치 (확장 / 그룹 토큰)
    [s.layout.left, s.layout.right].forEach((tokens, ci) => {
        for (const t of tokens) {
            if (t.startsWith('g:')) {
                const gel = gEls.get(t.slice(2));
                if (gel && !placed.has(gel)) add(cols[ci], gel);
            } else {
                const el = map.get(t);
                if (el && !placed.has(el)) add(cols[ci], el);
            }
        }
    });

    // 3) 어느 컬럼에도 기록되지 않은 그룹 → 개수가 적은 쪽
    for (const gel of gEls.values()) {
        if (placed.has(gel)) continue;
        add(want.get(cols[0]).length <= want.get(cols[1]).length ? cols[0] : cols[1], gel);
    }

    // 4) 저장된 적 없는 새 확장: 설정(newPlacement)에 따라 컬럼을 정해 맨 끝에 배치
    let addedNew = false;
    cols.forEach((col, ci) => {
        [...col.children].filter(isItem).forEach(el => {
            if (placed.has(el)) return;
            let target = ci; // keep: 확장이 붙은 컬럼 그대로
            if (s.newPlacement === 'left') target = 0;
            else if (s.newPlacement === 'right') target = 1;
            else if (s.newPlacement === 'balance') target = want.get(cols[0]).length <= want.get(cols[1]).length ? 0 : 1;
            if (s.newPlacement !== 'keep') addedNew = true;
            add(cols[target], el);
        });
    });

    // 5) 실제 DOM과 달라진 컨테이너만 다시 배치
    const differs = [...want].filter(([container, arr]) => {
        const cur = [...container.children].filter(c => isItem(c) || isGroupEl(c));
        return cur.length !== arr.length || arr.some((el, i) => el !== cur[i]);
    });
    if (differs.length) {
        observer?.disconnect();
        for (const [container, arr] of differs) arr.forEach(el => container.appendChild(el));
        startObserver();
    }
    if (addedNew) saveLayout(); // 배치한 새 확장을 '기존 확장'으로 기록
}

/** 그룹 하나(와 그 안의 하위 그룹)의 현재 구성을 저장 */
function saveGroup(gel, present) {
    const g = getSettings().groups[gel.dataset.gid];
    if (!g) return;
    const here = [];
    for (const ch of groupSlots(gel)) {
        if (isGroupEl(ch)) {
            here.push(`g:${ch.dataset.gid}`);
            saveGroup(ch, present);
        } else {
            here.push(getKey(ch));
        }
    }
    const hereSet = new Set(here);
    // 지금 로드되지 않은(비활성화 등) 확장의 자리는 뒤에 기억
    g.items = [...here, ...g.items.filter(k => !k.startsWith('g:') && !hereSet.has(k) && !present.has(k))];
}

/** 현재 DOM 상태(컬럼/그룹/순서)를 그대로 저장 */
function saveLayout() {
    const s = getSettings();
    const cols = getColumns();
    const present = new Set(getItems().map(getKey));
    const lists = [[], []];

    cols.forEach((col, ci) => {
        [...col.children].forEach(ch => {
            if (isGroupEl(ch)) {
                lists[ci].push(`g:${ch.dataset.gid}`);
                saveGroup(ch, present);
            } else if (isItem(ch)) {
                lists[ci].push(getKey(ch));
            }
        });
    });

    const inLists = new Set(lists.flat());
    const grouped = new Set(Object.values(s.groups).flatMap(g => g.items));
    const remember = side => s.layout[side].filter(
        k => !k.startsWith('g:') && !inLists.has(k) && !present.has(k) && !grouped.has(k));

    s.layout = {
        left: [...lists[0], ...remember('left')],
        right: [...lists[1], ...remember('right')],
    };
    saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* 헤더 꾸미기 (즐겨찾기 아이콘 / 편집 컨트롤)                          */
/* ------------------------------------------------------------------ */
function decorateItem(item) {
    const toggle = item.querySelector('.inline-drawer-toggle');
    if (!toggle) return;
    const s = getSettings();
    const key = getKey(item);
    const d = getItemData(key);

    toggle.classList.add('stfav-toggle');
    applyAlias(item, toggle, d.alias);

    let badge = toggle.querySelector(':scope > .stfav-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'stfav-badge';
        toggle.prepend(badge);
    }
    badge.replaceChildren();
    if (d.fav) {
        const i = document.createElement('i');
        i.className = `stfav-star ${d.icon || s.defaultIcon}`;
        i.style.color = d.color || s.defaultColor;
        i.style.fontSize = `${s.iconSize}em`;
        badge.append(i);
    }
    badge.classList.toggle('stfav-empty', badge.childNodes.length === 0);

    toggle.querySelector(':scope > .stfav-ctrls')?.remove();
    if (editMode) {
        const c = document.createElement('span');
        c.className = 'stfav-ctrls';
        c.innerHTML =
            `<span class="stfav-btn fa-${d.fav ? 'solid' : 'regular'} fa-star" data-act="fav" title="즐겨찾기 켜기/끄기"></span>` +
            `<span class="stfav-btn fa-solid fa-pen" data-act="edit" title="표시 이름 / 아이콘 / 색상 설정"></span>`;
        const chevron = toggle.querySelector(':scope > .inline-drawer-icon');
        chevron ? toggle.insertBefore(c, chevron) : toggle.append(c);
    }
}

function decorateAll() {
    getItems().forEach(decorateItem);
    document.querySelectorAll('.stfav-group').forEach(renderGroup);
}

function refresh() {
    applyLayout();
    decorateAll();
}

function scheduleRefresh() {
    if (dragging || pending) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
}

function startObserver() {
    if (!observer) observer = new MutationObserver(scheduleRefresh);
    getColumns().forEach(c => observer.observe(c, { childList: true }));
}

/* ------------------------------------------------------------------ */
/* 간단한 팝업 (입력 / 확인)                                           */
/* ------------------------------------------------------------------ */
/** 팝업 안에서 일어난 마우스/터치 이벤트가 document까지 올라가
 *  SillyTavern의 '패널 바깥 클릭 시 닫기' 동작을 건드리지 않게 막는다 */
function isolateOverlay(overlay) {
    ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'pointerdown', 'pointerup']
        .forEach(t => overlay.addEventListener(t, ev => ev.stopPropagation()));
}

/** 터치 기기에서는 자동 포커스(키보드 튀어나옴)를 하지 않는다 */
const canAutoFocus = () => !window.matchMedia?.('(pointer: coarse)').matches;

function openDialog({ title, message, value, placeholder, okLabel = '확인', onOk }) {
    const hasInput = value !== undefined;
    const overlay = document.createElement('div');
    overlay.className = 'stfav-overlay';
    overlay.innerHTML = `
        <div class="stfav-modal">
            <h3></h3>
            <div class="stfav-hint stfav-dlg-msg"></div>
            ${hasInput ? '<input type="text" class="text_pole stfav-dlg-input">' : ''}
            <div class="stfav-actions">
                <div class="menu_button stfav-cancel">취소</div>
                <div class="menu_button stfav-save"></div>
            </div>
        </div>`;
    document.body.append(overlay);
    isolateOverlay(overlay);

    overlay.querySelector('h3').textContent = title;
    overlay.querySelector('.stfav-dlg-msg').textContent = message || '';
    overlay.querySelector('.stfav-save').textContent = okLabel;
    const input = overlay.querySelector('.stfav-dlg-input');
    if (input) {
        input.value = value;
        input.placeholder = placeholder || '';
        setTimeout(() => input.focus(), 0); // 그룹 이름 입력은 바로 타이핑할 수 있게 유지
    }

    const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    };
    const ok = () => { close(); onOk?.(input ? input.value : undefined); };
    const onKey = ev => {
        if (ev.key === 'Escape') close();
        else if (ev.key === 'Enter' && input) ok();
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) close(); });
    overlay.querySelector('.stfav-cancel').addEventListener('click', close);
    overlay.querySelector('.stfav-save').addEventListener('click', ok);
}

/* ------------------------------------------------------------------ */
/* 그룹 동작 (추가 / 이름 변경 / 삭제 / 접기)                           */
/* ------------------------------------------------------------------ */
function addGroup(parentGel = null) {
    openDialog({
        title: parentGel ? '새 하위 그룹 만들기' : '새 그룹 만들기',
        message: '덜 보는 확장들을 이 그룹 안으로 끌어다 넣으세요.',
        value: '',
        placeholder: '예: 자주 안 쓰는 확장',
        okLabel: '만들기',
        onOk: (name) => {
            name = (name || '').trim();
            if (!name) return;
            const s = getSettings();
            const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
            s.groups[id] = { name, items: [] };
            openGroups.add(id); // 방금 만든 그룹은 펼쳐서 보여줌 (이번 세션 한정)
            const gel = ensureGroupEl(id);

            if (parentGel) {
                groupBody(parentGel).prepend(gel);
            } else {
                const cols = getColumns();
                const counts = cols.map(c => slotsOf(c).length);
                const col = counts[0] <= (counts[1] ?? Infinity) ? cols[0] : cols[1];
                col.prepend(gel);
            }

            saveLayout();
            decorateAll();
            gel.scrollIntoView({ block: 'nearest' });
        },
    });
}

function renameGroup(gel) {
    const s = getSettings();
    const g = s.groups[gel.dataset.gid];
    if (!g) return;
    openDialog({
        title: '그룹 이름 변경',
        value: g.name,
        okLabel: '저장',
        onOk: (name) => {
            name = (name || '').trim();
            if (!name) return;
            g.name = name;
            saveSettingsDebounced();
            renderGroup(gel);
        },
    });
}

function deleteGroup(gel) {
    const s = getSettings();
    const id = gel.dataset.gid;
    const g = s.groups[id];
    if (!g) return;
    openDialog({
        title: '그룹 삭제',
        message: `"${g.name}" 그룹을 삭제할까요? 안에 있던 확장과 하위 그룹은 그 자리에서 밖으로 나와요.`,
        okLabel: '삭제',
        onOk: () => {
            const frag = document.createDocumentFragment();
            groupSlots(gel).forEach(el => frag.append(el)); // 하위 그룹도 함께 밖으로
            gel.before(frag);
            gel.remove();
            delete s.groups[id];
            openGroups.delete(id);
            saveLayout();
            decorateAll();
        },
    });
}

function toggleGroup(gel) {
    const g = getSettings().groups[gel.dataset.gid];
    if (!g) return;
    const id = gel.dataset.gid;
    if (openGroups.has(id)) openGroups.delete(id);
    else openGroups.add(id);
    renderGroup(gel);
}

document.addEventListener('click', (e) => {
    if (!ACTIVE) return;
    const header = e.target.closest?.('.stfav-group-header');
    if (!header) return;
    e.stopPropagation(); // 같은 클릭을 다른 사본이 한 번 더 처리하지 못하게
    const gel = header.closest('.stfav-group');
    const btn = e.target.closest('.stfav-gbtn');

    if (editMode) {
        if (btn?.dataset.act === 'rename') renameGroup(gel);
        else if (btn?.dataset.act === 'delete') deleteGroup(gel);
        else if (btn?.dataset.act === 'addsub') addGroup(gel);
        else if (!btn && Date.now() - lastDragEnd > 300) toggleGroup(gel); // 드래그 직후가 아니면 접기/펼치기
        return;
    }
    toggleGroup(gel);
}, true);

/* ------------------------------------------------------------------ */
/* 편집 모드 토글 / 버튼                                               */
/* ------------------------------------------------------------------ */
function updateButton() {
    const btn = document.getElementById('stfav_toggle_btn');
    if (btn) {
        btn.classList.toggle('stfav-active', editMode);
        btn.querySelector('span').textContent = editMode ? '편집 완료' : '순서·즐겨찾기 편집';
        btn.querySelector('i').className = editMode ? 'fa-solid fa-check' : 'fa-solid fa-sort';
    }
    const gbtn = document.getElementById('stfav_group_btn');
    if (gbtn) gbtn.style.display = editMode ? '' : 'none';
}

function toggleEdit() {
    editMode = !editMode;
    if (editMode && rEdit) toggleREdit(); // 정규식 그룹 편집과 동시에 켜지지 않게
    document.body.classList.toggle('stfav-editing', editMode);
    updateButton();
    decorateAll();
    if (editMode) {
        window.toastr?.info('칸을 잡고 끌어서 옮기세요. (터치는 꾹 누른 뒤 끌기) 그룹 이름 칸 가운데에 놓으면 그 그룹 안으로 들어가요.', '', { timeOut: 4000 });
    }
}

function findInstallButton() {
    const byId = document.getElementById('third_party_extension_button');
    if (byId) return byId;
    return [...document.querySelectorAll('#rm_extensions_block .menu_button, #rm_extensions_block input[type="button"]')]
        .find(el => /install extension/i.test(`${el.textContent} ${el.value || ''}`));
}

function mountButton() {
    if (document.getElementById('stfav_toggle_btn')) return true;
    const anchor = findInstallButton();
    if (!anchor) return false;

    const btn = document.createElement('div');
    btn.id = 'stfav_toggle_btn';
    btn.className = 'menu_button menu_button_icon interactable';
    btn.tabIndex = 0;
    btn.title = '확장 순서 바꾸기 / 그룹 / 즐겨찾기 설정';
    btn.innerHTML = '<i class="fa-solid fa-sort"></i><span>순서·즐겨찾기 편집</span>';
    btn.addEventListener('click', toggleEdit);
    anchor.after(btn);

    const gbtn = document.createElement('div');
    gbtn.id = 'stfav_group_btn';
    gbtn.className = 'menu_button menu_button_icon interactable';
    gbtn.tabIndex = 0;
    gbtn.title = '확장들을 묶을 그룹 만들기';
    gbtn.innerHTML = '<i class="fa-solid fa-folder-plus"></i><span>그룹 추가</span>';
    gbtn.style.display = 'none';
    gbtn.addEventListener('click', () => addGroup());
    btn.after(gbtn);

    updateButton();
    return true;
}

/* ------------------------------------------------------------------ */
/* 클릭 처리 (편집 모드에서 헤더 클릭이 확장을 펼치지 않도록 가로챔)    */
/* ------------------------------------------------------------------ */
document.addEventListener('click', (e) => {
    if (!ACTIVE || !editMode) return;
    const toggle = e.target.closest?.('.inline-drawer-toggle.stfav-toggle');
    if (!toggle || !toggle.closest(COL_SEL)) return;

    const btn = e.target.closest('.stfav-btn');
    if (!btn && e.target.closest('a, button, input, select, textarea, .menu_button')) return;

    e.stopPropagation();
    e.preventDefault();
    if (!btn) return;

    const item = findItem(toggle);
    if (!item) return;
    const key = getKey(item);

    if (btn.dataset.act === 'fav') {
        setItemData(key, { fav: !getItemData(key).fav });
        decorateItem(item);
    } else if (btn.dataset.act === 'edit') {
        openEditor(item);
    }
}, true);

/* ------------------------------------------------------------------ */
/* 칸(확장 / 그룹) 통째로 잡고 끌어서 이동                              */
/* ------------------------------------------------------------------ */
document.addEventListener('pointerdown', (e) => {
    if (!ACTIVE || !editMode || pending || dragging) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    let item = null;
    const gh = e.target.closest?.('.stfav-group-header');
    const toggle = e.target.closest?.('.inline-drawer-toggle.stfav-toggle');

    if (gh && gh.closest(COL_SEL)) {
        if (e.target.closest('.stfav-gbtn')) return;
        item = gh.closest('.stfav-group');
    } else if (toggle && toggle.closest(COL_SEL)) {
        if (e.target.closest('.stfav-btn, a, button, input, select, textarea, .menu_button')) return;
        item = findItem(toggle);
    }
    if (!item) return;

    const touch = e.pointerType !== 'mouse';
    pending = { item, x: e.clientX, y: e.clientY, touch, timer: null };
    if (touch) pending.timer = setTimeout(beginDrag, TOUCH_HOLD_MS);

    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
});

// 터치로 드래그 중일 때 화면이 같이 스크롤되지 않게
document.addEventListener('touchmove', (e) => {
    if (ACTIVE && dragging && e.cancelable) e.preventDefault();
}, { passive: false });

// 꾹 누를 때 뜨는 컨텍스트 메뉴 방지
document.addEventListener('contextmenu', (e) => {
    if (ACTIVE && (pending || dragging)) e.preventDefault();
});

function beginDrag() {
    if (!pending) return;
    clearTimeout(pending.timer);
    dragging = { item: pending.item };
    pending = null;
    dragging.item.classList.add('stfav-dragging');
    document.body.classList.add('stfav-noselect');
    observer?.disconnect();
    navigator.vibrate?.(15);
}

function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    removePointerListeners();
}

function removePointerListeners() {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerEnd, true);
    window.removeEventListener('pointercancel', onPointerEnd, true);
}

function onPointerMove(e) {
    // 마우스 버튼이 이미 떼어졌는데 드래그/대기 상태가 남아 있으면(버튼 뗀 걸 놓친 경우) 즉시 종료
    if ((pending || dragging) && e.pointerType === 'mouse' && e.buttons === 0) {
        onPointerEnd();
        return;
    }
    if (pending && !dragging) {
        const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
        if (pending.touch) {
            if (dist > 8) cancelPending(); // 꾹 누르기 전에 움직이면 스크롤로 간주
            return;
        }
        if (dist > MOUSE_THRESHOLD) beginDrag();
        else return;
    }
    if (dragging) onDragMove(e);
}

function onDragMove(e) {
    const drag = dragging.item;
    const dragIsGroup = isGroupEl(drag);

    // 가장자리에 가면 패널 자동 스크롤
    const sc = document.getElementById('rm_extensions_block');
    if (sc) {
        const r = sc.getBoundingClientRect();
        if (e.clientY < r.top + 40) sc.scrollTop -= 12;
        else if (e.clientY > r.bottom - 40) sc.scrollTop += 12;
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    setDropTarget(null);
    if (!el || drag.contains(el)) return;

    const placeAt = (target, before) => {
        if (before ? target.previousElementSibling === drag : target.nextElementSibling === drag) return;
        target.parentNode.insertBefore(drag, before ? target : target.nextSibling);
    };
    const place = (target, rect) => placeAt(target, e.clientY < rect.top + rect.height / 2);

    // 0) 그룹 헤더 위: 위쪽 = 그룹 앞, 아래쪽 = 그룹 뒤(접힌 그룹만), 가운데 = 그룹 안에 넣기(놓을 때 적용)
    //    접힌 그룹도 펼치지 않고 바로 넣을 수 있음.
    //    그룹은 '하위 그룹이 없는 그룹'을 '최상위 그룹'에만 넣을 수 있음 (최대 2단계)
    const hdr = el.closest('.stfav-group-header');
    if (hdr) {
        const gel = hdr.parentElement;
        const r = hdr.getBoundingClientRect();
        const ratio = (e.clientY - r.top) / Math.max(r.height, 1);
        const collapsed = gel.classList.contains('stfav-collapsed');
        const canInside = !dragIsGroup || (!drag.querySelector('.stfav-group') && !isNestedGroup(gel));
        if (canInside) {
            if (ratio < 0.22) placeAt(gel, true);
            else if (collapsed && ratio > 0.78) placeAt(gel, false);
            else setDropTarget(gel);
        } else {
            // 안에 넣을 수 없는 경우: 위쪽 절반은 앞, 접힌 그룹의 아래쪽 절반은 뒤
            placeAt(gel, !(collapsed && ratio >= 0.5));
        }
        return;
    }

    // 1) 그룹 본문 위
    //    - 확장: 어떤 그룹(하위 그룹 포함)에든 들어갈 수 있음
    //    - 그룹: 하위 그룹이 없는 그룹만, 최상위 그룹 안으로만 들어갈 수 있음 (최대 2단계)
    let body = el.closest('.stfav-group-body');
    if (body && dragIsGroup) {
        const canNest = !drag.querySelector('.stfav-group');
        const owner = body.parentElement;
        if (!canNest) body = null;
        else if (isNestedGroup(owner)) body = owner.parentElement; // 한 단계 위(최상위 그룹 본문) 기준으로
    }
    if (body) {
        const target = childOf(body, el);
        if (target) {
            if (target !== drag && (isItem(target) || isGroupEl(target))) {
                place(target, target.getBoundingClientRect());
            }
        } else {
            const list = groupSlots(body.parentElement);
            const first = list[0];
            const last = list[list.length - 1];
            if (!last) body.appendChild(drag);
            else if (first !== drag && e.clientY < first.getBoundingClientRect().top) body.insertBefore(drag, first);
            else if (last !== drag && e.clientY > last.getBoundingClientRect().bottom) body.appendChild(drag);
        }
        return;
    }

    // 2) 컬럼 레벨
    let col = el.closest(COL_SEL);
    if (!col) col = columnAbove(e.clientX, e.clientY); // 컬럼 위쪽 영역(버튼/제목 줄 등)이면 그 컬럼 맨 위로
    if (!col) return;
    const slot = childOf(col, el);
    if (slot && (isGroupEl(slot) || isItem(slot))) {
        if (slot === drag) return;
        place(slot, slot.getBoundingClientRect());
    } else {
        // 칸이 아닌 영역(첫 칸 위쪽 여백, 제목 요소, 마지막 칸 아래, 빈 컬럼) → 맨 위 / 맨 끝으로
        const list = slotsOf(col);
        const first = list[0];
        const last = list[list.length - 1];
        if (!last) col.appendChild(drag);
        else if (first !== drag && e.clientY < first.getBoundingClientRect().top) col.insertBefore(drag, first);
        else if (last !== drag && e.clientY > last.getBoundingClientRect().bottom) col.appendChild(drag);
    }
}

/** '안에 넣기' 대상 그룹 강조 표시 */
function setDropTarget(gel) {
    if (dropTarget === gel) return;
    dropTarget?.classList.remove('stfav-drop-target');
    dropTarget = gel;
    gel?.classList.add('stfav-drop-target');
}

/** 포인터가 컬럼들보다 위쪽에 있을 때, 가로 범위가 겹치는 가장 위의 컬럼 */
function columnAbove(x, y) {
    let best = null;
    for (const c of getColumns()) {
        const r = c.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y < r.top && (!best || r.top < best.top)) best = { c, top: r.top };
    }
    return best?.c || null;
}

function onPointerEnd() {
    if (pending && !dragging) { cancelPending(); return; }
    if (!dragging) return;

    removePointerListeners();
    lastDragEnd = Date.now();
    const drag = dragging.item;
    const into = dropTarget;
    setDropTarget(null);
    if (into && into !== drag && !drag.contains(into)) {
        // 그룹 헤더 가운데에 놓음 → 그 그룹 안으로 (접힌 그룹은 끝에, 펼친 그룹은 맨 앞에)
        const body = groupBody(into);
        if (into.classList.contains('stfav-collapsed')) body.appendChild(drag);
        else body.insertBefore(drag, body.firstChild);
    }
    dragging.item.classList.remove('stfav-dragging');
    document.body.classList.remove('stfav-noselect');
    dragging = null;

    saveLayout();     // 놓은 그대로 (컬럼 + 그룹 + 순서) 저장
    startObserver();
    decorateAll();
}

/* ------------------------------------------------------------------ */
/* 아이콘 / 색상 편집 팝업                                             */
/* ------------------------------------------------------------------ */
function openEditor(item) {
    const s = getSettings();
    const key = getKey(item);
    const d = getItemData(key);

    const overlay = document.createElement('div');
    overlay.className = 'stfav-overlay';
    overlay.innerHTML = `
        <div class="stfav-modal">
            <h3>표시 이름 · 즐겨찾기 아이콘 설정</h3>
            <div class="stfav-name"></div>

            <label>표시 이름</label>
            <input type="text" class="text_pole stfav-alias-input">
            <div class="stfav-hint">확장란에 보이는 이름만 바뀌고, 실제 확장 이름은 그대로예요. 비워두면 원래 이름을 써요.</div>

            <label>Font Awesome 아이콘</label>
            <input type="text" class="text_pole stfav-icon-input" placeholder="${s.defaultIcon}">
            <div class="stfav-hint">클래스(fa-solid fa-heart) 또는 &lt;i class="..."&gt;&lt;/i&gt; 태그를 통째로 붙여넣어도 돼요. 비워두면 기본 아이콘을 써요.</div>
            <div class="stfav-presets"></div>

            <label>색상</label>
            <div class="stfav-color-row">
                <input type="color" class="stfav-color-input">
                <label class="checkbox_label"><input type="checkbox" class="stfav-usedefault"><span>기본 색상 사용</span></label>
            </div>

            <div class="stfav-preview"><span>미리보기</span><i></i><b class="stfav-prev-name"></b></div>

            <div class="stfav-actions">
                <div class="menu_button stfav-reset">초기화</div>
                <div class="menu_button stfav-cancel">취소</div>
                <div class="menu_button stfav-save">저장</div>
            </div>
        </div>`;
    document.body.append(overlay);
    isolateOverlay(overlay);

    const $ = sel => overlay.querySelector(sel);
    const origName = getDisplayName(item);
    $('.stfav-name').textContent = `원래 이름: ${origName}`;
    const aliasInput = $('.stfav-alias-input');
    const iconInput = $('.stfav-icon-input');
    const colorInput = $('.stfav-color-input');
    const useDefault = $('.stfav-usedefault');
    const preview = $('.stfav-preview i');
    const prevName = $('.stfav-prev-name');

    aliasInput.value = d.alias || '';
    aliasInput.placeholder = origName;
    iconInput.value = d.icon || '';
    colorInput.value = d.color || s.defaultColor;
    useDefault.checked = !d.color;

    const updatePreview = () => {
        prevName.textContent = aliasInput.value.trim() || origName;
        preview.className = parseIcon(iconInput.value) || s.defaultIcon;
        preview.style.color = useDefault.checked ? s.defaultColor : colorInput.value;
        colorInput.disabled = useDefault.checked;
    };

    for (const cls of PRESET_ICONS) {
        const b = document.createElement('span');
        b.className = 'stfav-preset';
        b.title = cls;
        b.innerHTML = `<i class="${cls}"></i>`;
        b.addEventListener('click', () => { iconInput.value = cls; updatePreview(); });
        $('.stfav-presets').append(b);
    }

    aliasInput.addEventListener('input', updatePreview);
    iconInput.addEventListener('input', updatePreview);
    colorInput.addEventListener('input', updatePreview);
    useDefault.addEventListener('change', updatePreview);
    updatePreview();
    if (canAutoFocus()) setTimeout(() => aliasInput.focus(), 0);

    const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    };
    const onKey = ev => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) close(); });
    $('.stfav-cancel').addEventListener('click', close);
    $('.stfav-reset').addEventListener('click', () => {
        aliasInput.value = '';
        iconInput.value = '';
        useDefault.checked = true;
        colorInput.value = s.defaultColor;
        updatePreview();
    });
    $('.stfav-save').addEventListener('click', () => {
        const alias = aliasInput.value.trim();
        const icon = parseIcon(iconInput.value);
        const customStyle = !!icon || !useDefault.checked;
        // 이름만 바꾼 경우에는 즐겨찾기(별)를 억지로 켜지 않음
        const nameOnly = !customStyle && !d.fav && !!(alias || d.alias);
        setItemData(key, {
            fav: nameOnly ? false : true,
            icon,
            color: useDefault.checked ? '' : colorInput.value,
            alias,
        });
        decorateItem(item);
        close();
    });
}

/* ------------------------------------------------------------------ */
/* 설정 드로어 (기본 아이콘 / 기본 색상 / 새 확장 배치 / 초기화)        */
/* ------------------------------------------------------------------ */
function mountSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('stfav_settings')) return;
    const s = getSettings();

    const wrap = document.createElement('div');
    wrap.id = 'stfav_settings';
    wrap.className = 'extension_container';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Extension Arranger</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stfav-row">
                    <label for="stfav_default_icon">기본 아이콘</label>
                    <input id="stfav_default_icon" type="text" class="text_pole flex1" placeholder="fa-solid fa-star">
                </div>
                <div class="stfav-hint">Font Awesome에서 원하는 아이콘의 클래스명을 입력하시면 즐겨찾기 아이콘의 모양을 변경하실 수 있습니다. (예: fa-solid fa-heart)</div>
                <div class="stfav-row">
                    <label for="stfav_default_color">기본 색상</label>
                    <input id="stfav_default_color" type="color">
                </div>
                <div class="stfav-row">
                    <label for="stfav_icon_size">아이콘 크기</label>
                    <input id="stfav_icon_size" type="range" class="flex1" min="0.3" max="2" step="0.05">
                    <span id="stfav_icon_size_val"></span>
                </div>
                <div class="stfav-row">
                    <label for="stfav_new_placement">새 확장이 추가되면</label>
                    <select id="stfav_new_placement" class="text_pole">
                        <option value="keep">그대로 두기 (확장이 정한 위치)</option>
                        <option value="left">항상 왼쪽 컬럼으로</option>
                        <option value="right">항상 오른쪽 컬럼으로</option>
                        <option value="balance">개수가 적은 쪽 컬럼으로</option>
                    </select>
                </div>
                <div class="stfav-row stfav-btn-row">
                    <div id="stfav_reset_order" class="menu_button">배치·그룹 초기화</div>
                    <div id="stfav_reset_favs" class="menu_button">즐겨찾기 전체 해제</div>
                </div>
            </div>
        </div>`;
    host.append(wrap);

    const iconInput = wrap.querySelector('#stfav_default_icon');
    const colorInput = wrap.querySelector('#stfav_default_color');

    iconInput.value = s.defaultIcon;
    colorInput.value = s.defaultColor;

    iconInput.addEventListener('input', () => {
        s.defaultIcon = parseIcon(iconInput.value) || DEFAULTS.defaultIcon;
        saveSettingsDebounced();
        decorateAll();
    });
    colorInput.addEventListener('input', () => {
        s.defaultColor = colorInput.value;
        saveSettingsDebounced();
        decorateAll();
    });

    const sizeInput = wrap.querySelector('#stfav_icon_size');
    const sizeVal = wrap.querySelector('#stfav_icon_size_val');
    s.iconSize = Math.min(2, Math.max(0.3, Number(s.iconSize) || DEFAULTS.iconSize)); // 이전 범위로 저장된 값 보정
    sizeInput.value = s.iconSize;
    sizeVal.textContent = `${Number(s.iconSize).toFixed(2)}배`;
    sizeInput.addEventListener('input', () => {
        s.iconSize = parseFloat(sizeInput.value) || DEFAULTS.iconSize;
        sizeVal.textContent = `${s.iconSize.toFixed(2)}배`;
        saveSettingsDebounced();
        decorateAll();
    });

    const placementSel = wrap.querySelector('#stfav_new_placement');
    placementSel.value = s.newPlacement;
    placementSel.addEventListener('change', () => {
        s.newPlacement = placementSel.value;
        // 저장된 배치가 없으면, 지금 있는 확장들을 '기존 확장'으로 먼저 기록해 둔다
        if (s.newPlacement !== 'keep' && !s.layout.left.length && !s.layout.right.length) saveLayout();
        saveSettingsDebounced();
    });

    wrap.querySelector('#stfav_reset_order').addEventListener('click', () => {
        s.layout = { left: [], right: [] };
        s.groups = {};
        s.rgroups = {};
        s.rlayout = { global: [], preset: [], scoped: [] };
        saveSettingsDebounced();
        window.toastr?.info('저장된 배치와 그룹(확장·정규식)을 지웠어요. 페이지를 새로고침하면 원래 모습으로 돌아와요. (정규식 실행 순서는 지금 상태 그대로 유지돼요)');
    });
    wrap.querySelector('#stfav_reset_favs').addEventListener('click', () => {
        // 즐겨찾기/아이콘/색상만 지우고, 직접 정한 표시 이름은 남겨둠
        const kept = {};
        for (const [k, v] of Object.entries(s.items)) {
            if (v?.alias) kept[k] = { alias: v.alias };
        }
        s.items = kept;
        saveSettingsDebounced();
        decorateAll();
    });
}

/* ------------------------------------------------------------------ */
/* Regex 스크립트 그룹                                                  */
/*  - Global / Preset / Scoped 목록마다 따로 그룹을 만들 수 있다.        */
/*  - 정규식은 '위에서 아래' 순서로 실행되므로, 화면 순서 = 실행 순서.    */
/*    놓은 뒤 순서가 바뀌었으면 SillyTavern 자체 정렬 저장 로직을 호출해  */
/*    실제 스크립트 순서에도 그대로 반영한다.                            */
/* ------------------------------------------------------------------ */
const R_TYPES = [
    ['global', '#saved_regex_scripts'],
    ['preset', '#saved_preset_scripts'],
    ['scoped', '#saved_scoped_scripts'],
];
const R_SEL = R_TYPES.map(t => t[1]).join(', ');

let rEdit = false;          // 정규식 그룹 편집 모드
let rPending = null;
let rDrag = null;
let rObserver = null;
let rTimer = null;
let rLastDragEnd = 0;
let rDropTarget = null;

const rContOf = type => document.querySelector(R_TYPES.find(t => t[0] === type)?.[1] || '#__none__');
const rConts = () => R_TYPES.map(([type, sel]) => [type, document.querySelector(sel)]).filter(([, el]) => el);
const rTypeOf = el => R_TYPES.find(([, sel]) => el.closest(sel))?.[0] ?? null;
const rIsGroup = el => !!el?.classList?.contains('stfav-rgroup');
const rIsScript = el => !!el?.classList?.contains('regex-script-label');
const rBody = gel => gel.querySelector(':scope > .stfav-rgroup-body');
const rSlots = cont => [...cont.children].filter(c => rIsScript(c) || rIsGroup(c));
const rBodySlots = gel => [...rBody(gel).children].filter(rIsScript);
/** 컨테이너 안의 모든 스크립트 (문서 순서 = 화면 위→아래 = 실행 순서) */
const rScripts = cont => [...cont.querySelectorAll('.regex-script-label')];

function ensureRGroupEl(id) {
    let gel = document.querySelector(`.stfav-rgroup[data-gid="${id}"]`);
    if (!gel) {
        gel = document.createElement('div');
        gel.className = 'stfav-rgroup';
        gel.dataset.gid = id;
        gel.innerHTML =
            '<div class="stfav-rgroup-header">' +
            '<i class="stfav-rgroup-chevron fa-solid fa-chevron-right"></i>' +
            '<b class="stfav-rgroup-name"></b>' +
            '<span class="stfav-rgroup-count"></span>' +
            '<span class="stfav-rgtoggle" title="그룹 안의 스크립트 전체 켜기/끄기"></span>' +
            '<span class="stfav-rgctrls">' +
            '<span class="stfav-rgbtn fa-solid fa-pen" data-act="rename" title="그룹 이름 변경"></span>' +
            '<span class="stfav-rgbtn fa-solid fa-trash" data-act="delete" title="그룹 삭제 (안의 스크립트는 밖으로 나와요)"></span>' +
            '</span>' +
            '</div>' +
            '<div class="stfav-rgroup-body"></div>';
    }
    renderRGroup(gel);
    return gel;
}

function renderRGroup(gel) {
    const s = getSettings();
    const id = gel.dataset.gid;
    const g = s.rgroups[id];
    if (!g) return;
    const present = rBodySlots(gel).length;
    gel.querySelector('.stfav-rgroup-name').textContent = g.name;
    gel.querySelector('.stfav-rgroup-count').textContent = `(${present})`;
    gel.classList.toggle('stfav-rcollapsed', !openGroups.has(id));
    // Preset/Scoped: 다른 프리셋·캐릭터의 스크립트만 들어 있는 그룹은 숨김
    const foreign = g.type !== 'global' && present === 0 && g.items.length > 0;
    gel.style.display = foreign ? 'none' : '';

    // 그룹 전체 켜기/끄기 스위치 (정규식 기본 토글과 같은 모양)
    const tg = gel.querySelector(':scope > .stfav-rgroup-header .stfav-rgtoggle');
    const st = rGroupState(gel);
    tg.style.display = st ? '' : 'none';
    tg.className = 'stfav-rgtoggle fa-solid ' + (st === 'off' ? 'regex-toggle-off fa-toggle-off' : 'regex-toggle-on fa-toggle-on');
    tg.classList.toggle('stfav-rgtoggle-mixed', st === 'mixed');
    tg.title = st === 'mixed' ? '일부만 켜져 있어요 (누르면 전부 켬)' : st === 'off' ? '그룹 전체 켜기' : '그룹 전체 끄기';
}

/** 그룹 안 스크립트의 켜짐 상태: 'on' | 'off' | 'mixed' | null(비어 있음). disable_regex 체크 = 꺼짐 */
function rGroupState(gel) {
    const boxes = [...rBody(gel).querySelectorAll('.disable_regex')];
    if (!boxes.length) return null;
    const off = boxes.filter(b => b.checked).length;
    return off === 0 ? 'on' : off === boxes.length ? 'off' : 'mixed';
}

/** 그룹 안 스크립트를 한꺼번에 켜거나 끈다 (실리태번의 일괄 켜기/끄기 기능을 그대로 사용 → 저장·채팅 새로고침 1번) */
function toggleRGroupScripts(gel) {
    const st = rGroupState(gel);
    if (!st) return;
    const enable = st !== 'on';
    const rows = rBodySlots(gel).filter(el => el.querySelector('.disable_regex')?.checked === enable);
    if (!rows.length) return;
    const btn = document.getElementById(enable ? 'bulk_enable_regex' : 'bulk_disable_regex');
    const boxes = document.querySelectorAll('#regex_container .regex_bulk_checkbox');
    if (btn && boxes.length) {
        boxes.forEach(cb => { cb.checked = false; });
        rows.forEach(el => { const cb = el.querySelector('.regex_bulk_checkbox'); if (cb) cb.checked = true; });
        btn.click();
    } else {
        // 일괄 기능이 없는 버전: 스크립트마다 기본 토글을 직접 누름
        rows.forEach(el => el.querySelector(enable ? '.regex-toggle-off' : '.regex-toggle-on')?.click());
    }
}

const rRenderAll = () => document.querySelectorAll('.stfav-rgroup').forEach(renderRGroup);

/** 저장된 그룹/순서를 DOM에 적용 */
function rApplyLayout() {
    const s = getSettings();
    const jobs = [];

    for (const [type, cont] of rConts()) {
        const gids = Object.keys(s.rgroups).filter(id => s.rgroups[id].type === type);
        if (!gids.length) continue;

        const map = new Map(rScripts(cont).map(el => [el.id, el]));
        const gEls = new Map(gids.map(id => [id, ensureRGroupEl(id)]));
        const placed = new Set();
        const want = new Map([[cont, []]]);
        const add = (c, el) => { want.get(c).push(el); placed.add(el); };

        for (const id of gids) {
            const body = rBody(gEls.get(id));
            want.set(body, []);
            for (const k of s.rgroups[id].items) {
                const el = map.get(k);
                if (el && !placed.has(el)) add(body, el);
            }
        }
        for (const t of s.rlayout[type] || []) {
            if (t.startsWith('g:')) {
                const gel = gEls.get(t.slice(2));
                if (gel && !placed.has(gel)) add(cont, gel);
            } else {
                const el = map.get(t);
                if (el && !placed.has(el)) add(cont, el);
            }
        }
        // 목록에 기록 없는 그룹은 맨 위, 새로 생긴 스크립트는 맨 끝 (SillyTavern도 새 스크립트를 맨 끝에 추가)
        const orphans = [...gEls.values()].filter(g => !placed.has(g));
        orphans.forEach(g => placed.add(g));
        want.get(cont).unshift(...orphans);
        for (const el of map.values()) if (!placed.has(el)) add(cont, el);

        for (const [c, arr] of want) {
            const cur = [...c.children].filter(ch => rIsScript(ch) || rIsGroup(ch));
            if (cur.length !== arr.length || arr.some((el, i) => el !== cur[i])) jobs.push([c, arr]);
        }
    }

    if (jobs.length) {
        rObserver?.disconnect();
        for (const [c, arr] of jobs) arr.forEach(el => c.appendChild(el));
        rStartObserver();
    }
}

/** 한 목록(type)의 현재 DOM 상태를 저장 */
function saveRLayout(type) {
    const s = getSettings();
    const cont = rContOf(type);
    if (!cont) return;
    const present = new Set(rScripts(cont).map(e => e.id));
    const tokens = [];
    const inTokens = new Set();

    for (const ch of cont.children) {
        if (rIsGroup(ch)) {
            const id = ch.dataset.gid;
            tokens.push(`g:${id}`);
            const g = s.rgroups[id];
            if (!g) continue;
            const here = rBodySlots(ch).map(e => e.id);
            const hs = new Set(here);
            // Preset/Scoped는 지금 안 보이는(다른 프리셋·캐릭터) 스크립트 자리를 기억해 둔다
            const keep = type === 'global' ? [] : g.items.filter(k => !hs.has(k) && !present.has(k));
            g.items = [...here, ...keep];
        } else if (rIsScript(ch)) {
            tokens.push(ch.id);
            inTokens.add(ch.id);
        }
    }
    const grouped = new Set(Object.values(s.rgroups).flatMap(g => g.items));
    const keepTop = type === 'global' ? [] : (s.rlayout[type] || []).filter(
        k => !k.startsWith('g:') && !inTokens.has(k) && !present.has(k) && !grouped.has(k));
    s.rlayout[type] = [...tokens, ...keepTop];
    saveSettingsDebounced();
}

/* 실리태번의 정렬 저장 핸들러(stop)는 호출될 때마다 reloadCurrentChat() + 목록 전체 재생성을 한다.
 * 그래서 놓을 때마다(또는 타이머로) 부르지 않고, 놓을 때는 화면/그룹 저장만 한다.
 * 실제 실행 순서 반영은 '정리 완료'를 누를 때 딱 한 번만 한다. */
const rDirty = new Set();   // 순서 반영이 필요한 목록 종류
const rBase = {};           // 마지막 반영 이후의 기준 순서 (type → id[])

function rQueueCommit(type) {
    rDirty.add(type); // 타이머 없음: 정리 완료 때 반영
}

function rFlushCommit() {
    if (rDrag || rPending) return; // 드래그 중엔 반영하지 않음
    const types = [...rDirty];
    rDirty.clear();
    for (const type of types) {
        const cont = rContOf(type);
        const base = rBase[type];
        delete rBase[type];
        if (!cont || !base) continue;
        const now = rScripts(cont).map(e => e.id);
        const changed = now.length !== base.length || now.some((id, i) => id !== base[i]);
        if (changed) commitROrder(type); // 실제 순서가 달라졌을 때만 (채팅 새로고침 1회)
    }
}

/** 화면 순서를 실제 스크립트 순서로 반영 (SillyTavern의 정렬 저장 핸들러를 그대로 사용) */
function commitROrder(type) {
    const $ = window.jQuery;
    const cont = rContOf(type);
    if (!cont || !$) return;
    let stop = null;
    try { stop = $(cont).sortable('instance')?.option('stop'); } catch { /* 정렬 기능 없음 */ }
    if (typeof stop !== 'function') {
        window.toastr?.warning('정규식 실행 순서를 자동으로 반영하지 못했어요. (이 버전의 실리태번은 지원되지 않을 수 있어요)');
        return;
    }
    rObserver?.disconnect();
    // 핸들러는 컨테이너의 직접 자식 순서를 읽으므로, 그 순간만 평평하게 펼쳐서 읽히게 한 뒤 그룹 모양으로 되돌린다
    rScripts(cont).forEach(el => cont.appendChild(el));
    try {
        Promise.resolve(stop.call(cont)).catch(err => console.error('[Extension Arranger] 순서 반영 실패', err));
    } catch (err) {
        console.error('[Extension Arranger] 순서 반영 실패', err);
    }
    rApplyLayout();
    rStartObserver();
}

/** 그룹이 있거나 편집 중이면 SillyTavern 기본 정렬(☰)을 꺼서, 그룹 안 스크립트가 목록에서 빠지는 일을 막는다 */
function rApplyDisabled() {
    const $ = window.jQuery;
    if (!$?.fn?.sortable) return;
    const s = getSettings();
    for (const [type, cont] of rConts()) {
        const lock = rEdit || Object.values(s.rgroups).some(g => g.type === type);
        cont.classList.toggle('stfav-rlocked', lock);
        let inst = null;
        try { inst = $(cont).sortable('instance'); } catch { /* 아직 초기화 전 */ }
        if (inst && !!inst.options.disabled !== lock) $(cont).sortable('option', 'disabled', lock);
    }
}

function rRefresh() {
    rApplyLayout();
    rRenderAll();
    rApplyDisabled();
    rMountUi();
}

function rScheduleRefresh() {
    if (rDrag || rPending) return;
    // 실리태번이 목록을 다시 그리면 스크립트가 잠깐 그룹 밖에 평평하게 나타났다가 그룹으로 돌아가는 게 보였음.
    // → 변화가 감지되는 즉시(화면이 그려지기 전에) 그룹을 다시 입히고,
    //   비동기로 나눠 그려지는 경우를 위해 잠시 뒤 한 번 더 확인한다.
    rRefresh();
    clearTimeout(rTimer);
    rTimer = setTimeout(rRefresh, 150);
}

function rStartObserver() {
    if (!rObserver) rObserver = new MutationObserver(rScheduleRefresh);
    rConts().forEach(([, c]) => rObserver.observe(c, { childList: true }));
}

/* ---------- 그룹 추가 / 이름 변경 / 삭제 / 접기 ---------- */
function addRGroup(type) {
    openDialog({
        title: '새 정규식 그룹 만들기',
        message: '스크립트를 이 그룹 안으로 끌어다 넣으세요. 정규식은 화면 위→아래 순서로 실행되니, 그룹 안팎으로 옮기면 실행 순서도 화면 순서대로 바뀌어요.',
        value: '',
        placeholder: '예: 말풍선 꾸미기',
        okLabel: '만들기',
        onOk: (name) => {
            name = (name || '').trim();
            const cont = rContOf(type);
            if (!name || !cont) return;
            const s = getSettings();
            const id = `rg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
            s.rgroups[id] = { name, type, items: [] };
            openGroups.add(id);
            const gel = ensureRGroupEl(id);
            cont.prepend(gel); // 빈 그룹이라 실행 순서에는 영향 없음
            saveRLayout(type);
            rRenderAll();
            rApplyDisabled();
            gel.scrollIntoView({ block: 'nearest' });
        },
    });
}

function renameRGroup(gel) {
    const g = getSettings().rgroups[gel.dataset.gid];
    if (!g) return;
    openDialog({
        title: '그룹 이름 변경',
        value: g.name,
        okLabel: '저장',
        onOk: (name) => {
            name = (name || '').trim();
            if (!name) return;
            g.name = name;
            saveSettingsDebounced();
            renderRGroup(gel);
        },
    });
}

function deleteRGroup(gel) {
    const s = getSettings();
    const id = gel.dataset.gid;
    const g = s.rgroups[id];
    if (!g) return;
    openDialog({
        title: '그룹 삭제',
        message: `"${g.name}" 그룹을 삭제할까요? 안에 있던 스크립트는 그 자리에서 밖으로 나오고, 삭제되지는 않아요. (실행 순서도 그대로)`,
        okLabel: '삭제',
        onOk: () => {
            const frag = document.createDocumentFragment();
            rBodySlots(gel).forEach(el => frag.append(el));
            gel.before(frag);
            gel.remove();
            delete s.rgroups[id];
            openGroups.delete(id);
            saveRLayout(g.type);
            rRenderAll();
            rApplyDisabled();
        },
    });
}

function toggleRGroup(gel) {
    const id = gel.dataset.gid;
    if (openGroups.has(id)) openGroups.delete(id);
    else openGroups.add(id);
    renderRGroup(gel);
}

document.addEventListener('click', (e) => {
    if (!ACTIVE) return;
    const header = e.target.closest?.('.stfav-rgroup-header');
    if (!header) return;
    e.stopPropagation();
    const gel = header.parentElement;
    if (e.target.closest('.stfav-rgtoggle')) { toggleRGroupScripts(gel); return; }
    const btn = e.target.closest('.stfav-rgbtn');
    if (rEdit) {
        if (btn?.dataset.act === 'rename') renameRGroup(gel);
        else if (btn?.dataset.act === 'delete') deleteRGroup(gel);
        else if (!btn && Date.now() - rLastDragEnd > 300) toggleRGroup(gel);
        return;
    }
    toggleRGroup(gel);
}, true);

// 정규식 목록을 누르는 순간 기본 정렬이 켜져 있지 않은지 한 번 더 확인 (안전장치)
document.addEventListener('pointerdown', (e) => {
    if (ACTIVE && e.target.closest?.(R_SEL)) rApplyDisabled();
}, true);

/* ---------- 편집 모드 ---------- */
function updateREditButton() {
    const btn = document.getElementById('stfav_regex_edit_btn');
    if (!btn) return;
    btn.classList.toggle('stfav-active', rEdit);
    btn.querySelector('small').textContent = rEdit ? '정리 완료' : '그룹 정리';
    btn.querySelector('i').className = rEdit ? 'fa-solid fa-check' : 'fa-solid fa-folder-tree';
}

function toggleREdit() {
    rEdit = !rEdit;
    if (rEdit && editMode) toggleEdit(); // 확장 편집과 동시에 켜지지 않게 (확장 편집 중엔 확장 내용이 접혀 있음)
    document.body.classList.toggle('stfav-r-editing', rEdit);
    updateREditButton();
    rApplyDisabled();
    rRenderAll();
    if (!rEdit) rFlushCommit(); // 정리 완료: 밀린 순서 반영을 지금 한 번에
    if (rEdit) {
        window.toastr?.info('스크립트나 그룹 칸을 잡고 끌어서 옮기세요. (터치는 꾹 누른 뒤 끌기) 그룹 이름 칸 가운데에 놓으면 그 그룹 안으로 들어가요. 정규식은 화면 위→아래 순서로 실행돼요.', '', { timeOut: 5000 });
    }
}

/** 정규식 패널에 버튼들을 붙인다. 패널이 준비됐으면 true */
function rMountUi() {
    const row = document.getElementById('open_regex_editor')?.parentElement;
    if (!row || !rConts().length) return false;

    if (!document.getElementById('stfav_regex_edit_btn')) {
        const btn = document.createElement('div');
        btn.id = 'stfav_regex_edit_btn';
        btn.className = 'menu_button menu_button_icon interactable';
        btn.tabIndex = 0;
        btn.title = '정규식 스크립트를 그룹으로 정리 / 순서 바꾸기';
        btn.innerHTML = '<i class="fa-solid fa-folder-tree"></i><small>그룹 정리</small>';
        btn.addEventListener('click', toggleREdit);
        row.append(btn);
        updateREditButton();
    }
    for (const [type, cont] of rConts()) {
        if (cont.previousElementSibling?.classList.contains('stfav-rbar')) continue;
        const bar = document.createElement('div');
        bar.className = 'stfav-rbar';
        bar.innerHTML = '<div class="menu_button menu_button_icon interactable" title="이 목록에 그룹 만들기"><i class="fa-solid fa-folder-plus"></i><small>그룹 추가</small></div>';
        bar.firstChild.addEventListener('click', () => addRGroup(type));
        cont.before(bar);
    }
    return true;
}

/* ---------- 잡고 끌어서 이동 ---------- */
document.addEventListener('pointerdown', (e) => {
    if (!ACTIVE || !rEdit || rPending || rDrag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    let item = null;
    const gh = e.target.closest?.('.stfav-rgroup-header');
    if (gh) {
        if (e.target.closest('.stfav-rgbtn, .stfav-rgtoggle')) return;
        item = gh.parentElement;
    } else {
        const row = e.target.closest?.('.regex-script-label');
        if (!row) return;
        if (e.target.closest('input, label, select, textarea, a, button, .menu_button, .regex-toggle-on, .regex-toggle-off')) return;
        item = row;
    }
    if (!item?.closest(R_SEL)) return;

    const touch = e.pointerType !== 'mouse';
    rPending = { item, x: e.clientX, y: e.clientY, touch, timer: null };
    if (touch) rPending.timer = setTimeout(beginRDrag, TOUCH_HOLD_MS);
    window.addEventListener('pointermove', onRMove, true);
    window.addEventListener('pointerup', onREnd, true);
    window.addEventListener('pointercancel', onREnd, true);
});

document.addEventListener('touchmove', (e) => {
    if (ACTIVE && rDrag && e.cancelable) e.preventDefault();
}, { passive: false });

document.addEventListener('contextmenu', (e) => {
    if (ACTIVE && (rPending || rDrag)) e.preventDefault();
});

function removeRListeners() {
    window.removeEventListener('pointermove', onRMove, true);
    window.removeEventListener('pointerup', onREnd, true);
    window.removeEventListener('pointercancel', onREnd, true);
}

function cancelRPending() {
    if (rPending) clearTimeout(rPending.timer);
    rPending = null;
    removeRListeners();
}

function beginRDrag() {
    if (!rPending) return;
    clearTimeout(rPending.timer);
    const item = rPending.item;
    const type = rTypeOf(item);
    const cont = rContOf(type);
    rDrag = { item, type, before: cont ? rScripts(cont).map(e => e.id) : [] };
    if (cont && !rBase[type]) rBase[type] = rDrag.before.slice();
    rPending = null;
    item.classList.add('stfav-rdragging');
    document.body.classList.add('stfav-noselect');
    rObserver?.disconnect();
    navigator.vibrate?.(15);
}

function onRMove(e) {
    if ((rPending || rDrag) && e.pointerType === 'mouse' && e.buttons === 0) { onREnd(); return; }
    if (rPending && !rDrag) {
        const dist = Math.hypot(e.clientX - rPending.x, e.clientY - rPending.y);
        if (rPending.touch) {
            if (dist > 8) cancelRPending();
            return;
        }
        if (dist > MOUSE_THRESHOLD) beginRDrag();
        else return;
    }
    if (rDrag) onRDragMove(e);
}

function rSetDrop(gel) {
    if (rDropTarget === gel) return;
    rDropTarget?.classList.remove('stfav-rdrop-target');
    rDropTarget = gel;
    gel?.classList.add('stfav-rdrop-target');
}

function onRDragMove(e) {
    const drag = rDrag.item;
    const isGrp = rIsGroup(drag);
    const cont = rContOf(rDrag.type);
    if (!cont) return;

    const sc = document.getElementById('rm_extensions_block');
    if (sc) {
        const r = sc.getBoundingClientRect();
        if (e.clientY < r.top + 40) sc.scrollTop -= 12;
        else if (e.clientY > r.bottom - 40) sc.scrollTop += 12;
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    rSetDrop(null);
    // 다른 종류 목록(Global ↔ Preset ↔ Scoped)으로는 옮기지 않음 (그건 스크립트의 '이동' 버튼 기능)
    if (!el || drag.contains(el) || !cont.contains(el)) return;

    const placeAt = (target, before) => {
        if (before ? target.previousElementSibling === drag : target.nextElementSibling === drag) return;
        target.parentNode.insertBefore(drag, before ? target : target.nextSibling);
    };
    const place = (target, rect) => placeAt(target, e.clientY < rect.top + rect.height / 2);

    // 그룹 헤더 위
    const hdr = el.closest('.stfav-rgroup-header');
    if (hdr) {
        const gel = hdr.parentElement;
        const r = hdr.getBoundingClientRect();
        const ratio = (e.clientY - r.top) / Math.max(r.height, 1);
        const collapsed = gel.classList.contains('stfav-rcollapsed');
        if (isGrp) placeAt(gel, ratio < 0.5);
        else if (ratio < 0.22) placeAt(gel, true);
        else if (collapsed && ratio > 0.78) placeAt(gel, false);
        else rSetDrop(gel);
        return;
    }

    // 그룹 본문 위
    const body = el.closest('.stfav-rgroup-body');
    if (body) {
        const gel = body.parentElement;
        if (isGrp) { // 그룹은 그룹 안에 넣지 않음 → 그 그룹의 앞/뒤로
            const r = gel.getBoundingClientRect();
            placeAt(gel, e.clientY < r.top + r.height / 2);
            return;
        }
        const target = childOf(body, el);
        if (target) {
            if (target !== drag && rIsScript(target)) place(target, target.getBoundingClientRect());
        } else {
            const list = rBodySlots(gel);
            const first = list[0];
            const last = list[list.length - 1];
            if (!last) body.appendChild(drag);
            else if (first !== drag && e.clientY < first.getBoundingClientRect().top) body.insertBefore(drag, first);
            else if (last !== drag && e.clientY > last.getBoundingClientRect().bottom) body.appendChild(drag);
        }
        return;
    }

    // 목록 최상위
    const slot = childOf(cont, el);
    if (slot && (rIsGroup(slot) || rIsScript(slot))) {
        if (slot === drag) return;
        place(slot, slot.getBoundingClientRect());
    } else {
        const list = rSlots(cont);
        const first = list[0];
        const last = list[list.length - 1];
        if (!last) cont.appendChild(drag);
        else if (first !== drag && e.clientY < first.getBoundingClientRect().top) cont.insertBefore(drag, first);
        else if (last !== drag && e.clientY > last.getBoundingClientRect().bottom) cont.appendChild(drag);
    }
}

function onREnd() {
    if (rPending && !rDrag) { cancelRPending(); return; }
    if (!rDrag) return;

    removeRListeners();
    rLastDragEnd = Date.now();
    const { item, type } = rDrag;
    const into = rDropTarget;
    rSetDrop(null);
    if (into && into !== item && !item.contains(into)) {
        const body = rBody(into);
        if (into.classList.contains('stfav-rcollapsed')) body.appendChild(item);
        else body.insertBefore(item, body.firstChild);
    }
    item.classList.remove('stfav-rdragging');
    document.body.classList.remove('stfav-noselect');
    rDrag = null;

    saveRLayout(type);
    rStartObserver();
    rRenderAll();
    rQueueCommit(type); // 실제 실행 순서 반영은 잠시 뒤 한 번만
}

function bootRegexGroups() {
    let tries = 0;
    const timer = setInterval(() => {
        if (rMountUi()) {
            clearInterval(timer);
            rStartObserver();
            rRefresh();
            [800, 2500, 6000].forEach(ms => setTimeout(rRefresh, ms));
        } else if (++tries > 120) {
            clearInterval(timer);
        }
    }, 500);
}

/* ------------------------------------------------------------------ */
/* 시작                                                                */
/* ------------------------------------------------------------------ */
function boot() {
    // 시작할 때는 항상 모든 그룹을 닫힘으로 (이전 버전이 저장해 둔 펼침 값 제거)
    Object.values(getSettings().groups).forEach(g => { g.collapsed = true; });
    mountSettings();
    startObserver();
    refresh();

    // 늦게 로드되는 확장들을 위해 몇 번 더 시도
    [800, 2500, 6000].forEach(ms => setTimeout(refresh, ms));

    bootRegexGroups(); // Regex 패널이 준비되면 그룹 기능을 붙임

    // 버튼은 Extensions 패널이 준비될 때까지 기다렸다가 붙임
    let tries = 0;
    const timer = setInterval(() => {
        if (mountButton() || ++tries > 120) clearInterval(timer);
    }, 500);
}

jQuery(() => {
    if (!ACTIVE) return;
    let tries = 0;
    const wait = setInterval(() => {
        if (getColumns().length >= 1 || ++tries > 100) {
            clearInterval(wait);
            boot();
        }
    }, 300);
});
