const search = document.getElementById('search');
const drawerSearch = document.getElementById('drawer-search');
const articles = [...document.querySelectorAll('article')];
const links = [...document.querySelectorAll('[data-topic]')];
const groups = [...document.querySelectorAll('nav details')];
const directory = document.getElementById('directory');
const directorySlot = document.getElementById('directory-slot');
const dialog = document.getElementById('topics-dialog');
const toggle = document.getElementById('toggle-directory');
const preference = 'zhiyan:help-directory-collapsed';
let active = articles[0]?.id;
let collapsed = false;
try { collapsed = localStorage.getItem(preference) === 'true'; } catch { /* Storage can be disabled. */ }
function updateDirectoryPreference() {
  const expanded = Boolean(search.value.trim()) || !collapsed;
  document.body.dataset.directoryCollapsed = String(!expanded);
  toggle.textContent = expanded ? '收起目录' : '展开目录';
  toggle.disabled = Boolean(search.value.trim());
  toggle.setAttribute('aria-expanded', String(expanded));
  try { localStorage.setItem(preference, String(collapsed)); } catch { /* Storage can be disabled. */ }
}
function markActive(id, openGroup = true) {
  active = id;
  links.forEach(link => {
    if (link.dataset.topic === id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  groups.forEach(group => { group.dataset.active = String(Boolean(group.querySelector(`[data-topic="${CSS.escape(id)}"]`))); });
  if (openGroup && !search.value.trim()) groups.forEach(group => { group.open = Boolean(group.querySelector(`[data-topic="${CSS.escape(id)}"]`)); });
}
function filter() {
  const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  let count = 0;
  articles.forEach(article => {
    const match = words.every(word => article.textContent.toLocaleLowerCase().includes(word));
    article.hidden = !match;
    if (match) count++;
    links.find(link => link.dataset.topic === article.id).hidden = !match;
  });
  groups.forEach(group => {
    group.hidden = ![...group.querySelectorAll('[data-topic]')].some(link => !link.hidden);
    group.open = words.length > 0 || Boolean(group.querySelector(`[data-topic="${CSS.escape(active)}"]`));
  });
  document.getElementById('count').textContent = count + (words.length ? ' 个匹配主题' : ' 个主题');
  document.getElementById('empty').hidden = count !== 0;
  drawerSearch.value = search.value;
  updateDirectoryPreference();
}
search.addEventListener('input', () => {
  if (search.value.trim()) {
    if (window.matchMedia('(max-width: 960px)').matches && !dialog.open) openDrawer();
  }
  filter();
});
drawerSearch.addEventListener('input', () => { search.value = drawerSearch.value; filter(); });
groups.forEach(group => group.addEventListener('toggle', () => {
  if (group.open && !search.value.trim()) groups.forEach(other => { if (other !== group) other.open = false; });
}));
toggle.addEventListener('click', () => { collapsed = !collapsed; updateDirectoryPreference(); });
function openDrawer() {
  document.getElementById('drawer-body').append(directory);
  drawerSearch.value = search.value;
  dialog.showModal();
  drawerSearch.focus({ preventScroll: true });
}
document.getElementById('open-directory').addEventListener('click', openDrawer);
document.getElementById('close-directory').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => directorySlot.append(directory));
window.matchMedia('(min-width: 961px)').addEventListener('change', event => { if (event.matches && dialog.open) dialog.close(); });
directory.addEventListener('click', event => {
  const link = event.target.closest('[data-topic]');
  if (!link) return;
  event.preventDefault();
  const id = link.dataset.topic;
  if (dialog.open) dialog.close();
  search.value = ''; filter(); markActive(id);
  if (location.hash !== '#' + id) location.hash = id;
  requestAnimationFrame(() => {
    const article = document.getElementById(id);
    article.setAttribute('tabindex', '-1'); article.focus({ preventScroll: true }); article.scrollIntoView({ block: 'start' });
  });
});
document.getElementById('print').addEventListener('click', () => window.print());
document.querySelectorAll('.diagram-zoom').forEach(button => button.addEventListener('click', () => {
  const figure = button.closest('figure'); const zoom = figure.dataset.zoom !== 'true';
  figure.dataset.zoom = String(zoom); button.setAttribute('aria-pressed', String(zoom)); button.textContent = zoom ? '适应宽度' : '放大阅读';
}));
function revealHash() {
  let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const target = articles.find(article => article.id === id);
  if (target) { search.value = ''; filter(); markActive(id); target.scrollIntoView({ block: 'start' }); }
}
updateDirectoryPreference(); filter(); markActive(active); revealHash();
window.addEventListener('hashchange', revealHash);
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting && !entry.target.hidden).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) markActive(visible[0].target.id, false);
  }, { rootMargin: '-5% 0px -70% 0px', threshold: 0 });
  articles.forEach(article => observer.observe(article));
}
