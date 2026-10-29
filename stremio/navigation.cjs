'use strict';

// All menu hit targets use the same 1280 x 720 coordinate space as Switch touch.
// The raster renderer reads these rectangles instead of measuring its own targets.
const WIDTH = 1280, HEIGHT = 720;
const CATALOG_PAGE_SIZE = 4, LIST_PAGE_SIZE = 8, TAB_PAGE_SIZE = 7;
const clamp = (value, count) => Math.max(0, Math.min(Number.isSafeInteger(value) ? value : 0, Math.max(0, count - 1)));
const pageStart = (selected, size) => Math.floor(Math.max(0, selected) / size) * size;
const rect = (x, y, width, height) => ({x, y, width, height});
const label = value => typeof value === 'string' ? value.slice(0, 120) : '';

function buildNavigation(model = {}, {focusArea = 'content', sidebarIndex = 0, tabIndex, section} = {}) {
  const view = model.view || 'sources';
  const selected = Number.isSafeInteger(model.selectedIndex) ? model.selectedIndex : (model.offset || 0) + (model.selected || 0);
  const activeSection = section || (view === 'catalogs' ? 'catalogs' : ['library', 'continue'].includes(model.catalog?.kind) ? 'library' : 'home');
  const focusIndex = focusArea === 'sidebar' ? clamp(sidebarIndex, 3) : focusArea === 'tabs' ? tabIndex ?? model.catalog?.index ?? 0 : selected;
  const navigation = {width: WIDTH, height: HEIGHT, focus: {area: focusArea, index: focusIndex},
    sidebar: [], tabs: [], tabPaging: [], cards: [], rows: [], actions: [], paging: [], commands: []};
  if (view === 'playing') return navigation;
  navigation.sidebar = ['home', 'library', 'catalogs'].map((id, index) => ({id,
    label: ['Home', 'Library', 'Catalogs'][index], active: id === activeSection,
    focused: focusArea === 'sidebar' && index === focusIndex, disabled: false,
    ...rect(8, 128 + index * 88, 72, 78), icon: rect(28, 136 + index * 88, 32, 32),
    caption: rect(8, 180 + index * 88, 72, 20)}));
  navigation.commands = [{id: 'back', label: 'Back', ...rect(1106, 16, 60, 52)},
    {id: 'refresh', label: 'Refresh', ...rect(1178, 16, 70, 52)}];
  if (view === 'catalog') {
    navigation.tabs = (model.tabs || []).slice(0, TAB_PAGE_SIZE).map((tab, localIndex) => ({index: tab.index,
      label: label(tab.label), active: Boolean(tab.active), selected: Boolean(tab.selected),
      focused: focusArea === 'tabs' && tab.index === focusIndex, disabled: false,
      ...rect(170 + localIndex * 148, 92, 138, 44)}));
    const tabOffset = model.tabOffset || 0, tabCount = model.tabCount || 0;
    navigation.tabPaging = [{id: 'previousTabs', label: 'Previous catalogs', index: Math.max(0, tabOffset - TAB_PAGE_SIZE),
      disabled: tabOffset === 0, ...rect(126, 92, 34, 44)},
    {id: 'nextTabs', label: 'More catalogs', index: Math.min(Math.max(0, tabCount - 1), tabOffset + TAB_PAGE_SIZE),
      disabled: tabOffset + navigation.tabs.length >= tabCount, ...rect(1206, 92, 34, 44)}];
    navigation.cards = (model.cards || []).slice(0, CATALOG_PAGE_SIZE).map((card, localIndex) => ({index: card.index,
      selected: card.index === selected, focused: focusArea === 'content' && card.index === selected, disabled: false,
      ...rect(136 + localIndex * 280, 366, 256, 320),
      poster: rect(176 + localIndex * 280, 374, 176, 264),
      title: rect(136 + localIndex * 280, 656, 256, 24)}));
  } else {
    navigation.rows = (model.rows || []).slice(0, LIST_PAGE_SIZE).map((row, localIndex) => ({index: row.index ?? (model.offset || 0) + localIndex,
      selected: (row.index ?? (model.offset || 0) + localIndex) === selected,
      focused: focusArea === 'content' && (row.index ?? (model.offset || 0) + localIndex) === selected,
      disabled: Boolean(row.disabled),
      ...(view === 'details' ? rect(428, 390 + localIndex * 54, 816, 46) : rect(126, 204 + localIndex * 52, 1122, 46))}));
    if (view === 'details') navigation.actions = navigation.rows.map(row => ({...row}));
  }
  const pageSize = view === 'catalog' ? CATALOG_PAGE_SIZE : LIST_PAGE_SIZE;
  if (view !== 'details' && (model.count || 0) > pageSize) {
    const offset = model.offset || 0, count = model.count || 0;
    navigation.paging = [{id: 'previous', label: 'Previous page', index: Math.max(0, offset - pageSize),
      disabled: offset === 0, ...rect(1124, view === 'catalog' ? 318 : 150, 48, 38)},
    {id: 'next', label: 'Next page', index: Math.min(count - 1, offset + pageSize),
      disabled: offset + pageSize >= count, ...rect(1180, view === 'catalog' ? 318 : 150, 48, 38)}];
  }
  return navigation;
}

function hitTestNavigation(navigation, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
    point.x < 0 || point.x >= WIDTH || point.y < 0 || point.y >= HEIGHT) return null;
  for (const [key, area] of [['commands', 'command'], ['sidebar', 'sidebar'], ['tabPaging', 'tabPaging'],
    ['tabs', 'tabs'], ['paging', 'paging'], ['cards', 'content'], ['rows', 'content']]) {
    for (const target of navigation?.[key] || []) {
      if (point.x >= target.x && point.x < target.x + target.width && point.y >= target.y && point.y < target.y + target.height)
        return {...target, area};
    }
  }
  return null;
}

module.exports = {WIDTH, HEIGHT, CATALOG_PAGE_SIZE, LIST_PAGE_SIZE, TAB_PAGE_SIZE, pageStart, clamp, buildNavigation, hitTestNavigation};
