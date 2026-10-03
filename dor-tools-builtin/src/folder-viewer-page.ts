import { viewerTitle } from './file-viewer-format.js';
import { escapeHtml } from './viewer-http.js';

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
type Ordered = { dir: boolean; folded: string; entry: { name: string } };
/** The listing order: directories first, then by lowercased name, then by name. */
export const byDisplayOrder = (a: Ordered, b: Ordered): number =>
  Number(!a.dir) - Number(!b.dir) || compare(a.folded, b.folded) || compare(a.entry.name, b.entry.name);

export const FOLDER_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--vscode-sideBar-background,Canvas);color:var(--vscode-sideBar-foreground,CanvasText);font:var(--vscode-font-size,13px)/1.4 var(--vscode-font-family,system-ui,sans-serif)}
header{display:flex;align-items:center;gap:2px;min-height:32px;padding:3px 8px;box-shadow:inset 0 -1px color-mix(in srgb,currentColor 10%,transparent)}
#root{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
button{font:inherit;margin:0;border:0;border-radius:3px;padding:4px 6px;background:transparent;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
button:focus-visible{outline:1px solid var(--vscode-focusBorder,Highlight);outline-offset:-1px}
button[aria-pressed=false]{opacity:.5}
svg{width:16px;height:16px;flex:none;fill:currentColor}
ul{margin:0;padding:0;list-style:none}
#tree{flex:1;overflow:auto;padding:2px 0;outline:none}
.row{display:flex;align-items:center;gap:4px;height:22px;padding-right:8px;white-space:nowrap;cursor:default;user-select:none}
.row:hover{background:var(--vscode-list-hoverBackground,color-mix(in srgb,currentColor 7%,transparent))}
.chev{flex:none;width:12px;text-align:center;display:flex}
.chev svg{width:12px;height:12px}
.icon{display:flex;width:16px;height:16px;opacity:.8}
[aria-expanded="true"]>.row>.chev{transform:rotate(90deg)}
[aria-expanded="false"]>ul{display:none}
.name{overflow:hidden;text-overflow:ellipsis}
.ignored>.row,.note{opacity:.55}
.note{height:22px;font-style:italic}
#tree.hide-ignored .ignored{display:none}
[aria-selected="true"]>.row{background:var(--vscode-list-inactiveSelectionBackground,ButtonFace);color:var(--vscode-list-inactiveSelectionForeground,CanvasText)}
#tree:focus [aria-selected="true"]>.row{outline:1px solid var(--vscode-focusBorder,Highlight);outline-offset:-1px;background:var(--vscode-list-activeSelectionBackground,Highlight);color:var(--vscode-list-activeSelectionForeground,HighlightText)}
#status{padding:4px 8px;box-shadow:inset 0 1px color-mix(in srgb,currentColor 10%,transparent);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#status:empty{display:none}
`;

// Plain script inside a template literal: no backslashes, backticks, or interpolation.
const SCRIPT = `(function () {
  'use strict';
  var tree = document.getElementById('tree');
  var show = document.getElementById('show');
  var showIgnored = true;
  var status = document.getElementById('status');
  var root = { path: '', kind: 'dir', level: 0, parent: null, children: [], group: tree, expanded: true, loaded: false };
  var nodes = new WeakMap();
  var selected = null;
  var nextId = 0;
  var previewTimer = 0;
  var sequence = 0;
  var selectsSettled = Promise.resolve(); // once every select sent so far has settled; never rejects
  var stateTimer = 0;

  function fail(error) { status.textContent = error && error.message ? error.message : String(error); }
  function indent(level) { return (4 + (level - 1) * 12) + 'px'; }
  function contains(ancestor, node) {
    for (var n = node; n; n = n.parent) if (n === ancestor) return true;
    return false;
  }
  function hidden(node) {
    for (var n = node; n && n !== root; n = n.parent) if (n.ignored && !showIgnored) return true;
    return false;
  }
  function setIgnored(node, ignored) {
    node.ignored = ignored;
    node.li.classList.toggle('ignored', ignored);
  }

  function makeNode(parent, entry) {
    var li = document.createElement('li');
    li.id = 'n' + (++nextId);
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(parent.level + 1));
    li.setAttribute('aria-selected', 'false');
    var row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = indent(parent.level + 1);
    var chev = document.createElement('span');
    chev.className = 'chev';
    chev.setAttribute('aria-hidden', 'true');
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    row.appendChild(chev);
    var icon = document.createElement('span');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = entry.kind === 'dir'
      ? '<svg viewBox="0 0 16 16"><path d="M1.5 2h4l1.5 2h7.5l.5.5v9l-.5.5h-13l-.5-.5v-11zM2 3v10h12V5H6.5L5 3z"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M3 1h6l4 4v10H3zm1 1v12h8V6H8V2zm5 .5V5h2.5z"/></svg>';
    row.appendChild(icon);
    row.appendChild(name);
    row.title = entry.name;
    li.appendChild(row);
    var node = { name: entry.name, path: parent.path ? parent.path + '/' + entry.name : entry.name, kind: entry.kind,
      level: parent.level + 1, parent: parent, li: li, row: row, children: [], group: null, expanded: false, loaded: false };
    if (entry.kind === 'dir') {
      chev.innerHTML = '<svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5-.7-.7L9.6 8 5.3 3.7z"/></svg>';
      li.setAttribute('aria-expanded', 'false');
      node.group = document.createElement('ul');
      node.group.setAttribute('role', 'group');
      li.appendChild(node.group);
    }
    setIgnored(node, entry.ignored);
    nodes.set(li, node);
    return node;
  }

  function request(url, init) {
    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error(text || res.status + ' ' + res.statusText);
        return JSON.parse(text);
      });
    });
  }

  function requestList(node) { return request('list?dir=' + encodeURIComponent(node.path)); }

  // Applies a directory's listing, keeping the nodes (and expansion) of entries that remain.
  function apply(node, listing) {
    var previous = new Map();
    node.children.forEach(function (child) { previous.set(child.kind + '/' + child.name, child); });
    node.children = listing.entries.map(function (entry) {
      var key = entry.kind + '/' + entry.name;
      var child = previous.get(key);
      if (!child) return makeNode(node, entry);
      previous.delete(key);
      setIgnored(child, entry.ignored);
      return child;
    });
    previous.forEach(function (gone) { if (contains(gone, selected)) select(node === root ? null : node, false); });
    node.group.textContent = '';
    node.children.forEach(function (child) { node.group.appendChild(child.li); });
    if (listing.truncated) {
      var note = document.createElement('li');
      note.setAttribute('role', 'none');
      note.className = 'note';
      note.style.paddingLeft = indent(node.level + 1);
      note.textContent = 'More entries not shown';
      node.group.appendChild(note);
    }
    node.loaded = true;
  }

  function load(node) { return requestList(node).then(function (listing) { apply(node, listing); }); }

  // Lists the root and every loaded, expanded directory at once, then applies
  // the listings top-down, skipping a directory that a failed listing or its
  // parent's new one left out. A collapsed directory reloads when next expanded.
  function refresh() {
    var dirs = [];
    (function walk(node) {
      dirs.push(node);
      node.children.forEach(function (child) {
        if (!child.expanded) child.loaded = false;
        else if (child.loaded) walk(child);
      });
    })(root);
    return Promise.all(dirs.map(function (node) {
      return requestList(node).then(function (listing) { return { listing: listing }; }, function (error) { return { error: error }; });
    })).then(function (results) {
      var applied = new Set([null]);
      var error = null;
      dirs.forEach(function (node, i) {
        if (!applied.has(node.parent) || (node.parent && node.parent.children.indexOf(node) < 0)) return;
        if ('error' in results[i]) error = error || results[i].error;
        else { apply(node, results[i].listing); applied.add(node); }
      });
      if (error) throw error;
    });
  }

  function toggle(node, open) {
    if (node.kind !== 'dir') return;
    node.expanded = open === undefined ? !node.expanded : open;
    node.li.setAttribute('aria-expanded', String(node.expanded));
    if (!node.expanded && selected !== node && contains(node, selected)) select(node, false);
    if (node.expanded && !node.loaded && !node.loading) {
      node.loading = load(node).catch(fail).then(function () { node.loading = null; });
    }
    reportState();
  }

  // The view this process writes as its dehydrate payload when it is stopped
  // while idle, and reopens from when it starts again: the expanded folders
  // shown, the selection, and the ignored-files toggle.
  function viewState() {
    var expanded = [];
    (function walk(node) {
      node.children.forEach(function (child) {
        if (child.kind === 'dir' && child.expanded) { expanded.push(child.path); walk(child); }
      });
    })(root);
    return { expanded: expanded, selected: selected ? selected.path : null, showIgnored: showIgnored };
  }
  function reportState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(function () {
      request('state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(viewState()) })
        .catch(function () {});
    }, 300);
  }
  // A loaded node at a page path; a compacted row's path is its whole chain.
  function find(path) {
    var found = null;
    (function walk(node) {
      node.children.forEach(function (child) {
        if (found) return;
        if (child.path === path) found = child;
        else if (child.kind === 'dir' && child.loaded && path.indexOf(child.path + '/') === 0) walk(child);
      });
    })(root);
    return found;
  }
  // Parents before children, each awaited; a path the folder no longer has is skipped.
  function restore(saved) {
    if (!saved || !Array.isArray(saved.expanded)) return Promise.resolve();
    if (saved.showIgnored === false) setShowIgnored(false);
    var chain = Promise.resolve();
    saved.expanded.slice().sort(function (a, b) { return a.split('/').length - b.split('/').length; }).forEach(function (path) {
      chain = chain.then(function () {
        var node = find(path);
        if (!node || node.kind !== 'dir' || node.expanded) return null;
        toggle(node, true);
        return node.loading;
      });
    });
    return chain.then(function () {
      var node = typeof saved.selected === 'string' ? find(saved.selected) : null;
      if (node && !hidden(node)) select(node, false);
    });
  }

  // The latest request alone owns the status line; a superseded preview is not an error.
  // Each POST is its own HTTP connection, so an activate waits for every
  // select in flight: sent at once, it could overtake a double-click's select and
  // open beside the slot instead of pinning it. Selects stay concurrent, so the
  // newest supersedes.
  function send(action, node) {
    var mine = ++sequence;
    function post() {
      return request(action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: node.path }) })
        .catch(function (error) { return { ok: false, error: error.message }; });
    }
    var sent;
    if (action === 'select') {
      sent = post();
      selectsSettled = selectsSettled.then(function () { return sent; });
    } else {
      sent = selectsSettled.then(post);
    }
    sent.then(function (result) { if (mine === sequence) status.textContent = result.ok ? '' : result.error; });
  }

  // preview: 'now' (a click), 'settle' (arrowing), or false.
  function select(node, preview) {
    clearTimeout(previewTimer);
    if (node !== selected) status.textContent = '';
    if (selected) selected.li.setAttribute('aria-selected', 'false');
    selected = node;
    if (!node) { tree.removeAttribute('aria-activedescendant'); reportState(); return; }
    node.li.setAttribute('aria-selected', 'true');
    tree.setAttribute('aria-activedescendant', node.li.id);
    node.row.scrollIntoView({ block: 'nearest' });
    reportState();
    if (node.kind !== 'file' || !preview) return;
    if (preview === 'now') send('select', node);
    else previewTimer = setTimeout(function () { send('select', node); }, 150);
  }

  // The walk descends only through shown rows, so a child is hidden by its own flag alone.
  function rows() {
    var out = [];
    (function walk(parent) {
      parent.children.forEach(function (child) {
        if (child.ignored && !showIgnored) return;
        out.push(child);
        if (child.expanded) walk(child);
      });
    })(root);
    return out;
  }

  function nodeAt(target) {
    var li = target.closest ? target.closest('li[role="treeitem"]') : null;
    return li ? nodes.get(li) : null;
  }

  tree.addEventListener('click', function (event) {
    var node = nodeAt(event.target);
    // The second click of a double-click neither toggles back nor previews again.
    if (!node || event.detail > 1) return;
    select(node, 'now');
    toggle(node);
  });
  tree.addEventListener('dblclick', function (event) {
    var node = nodeAt(event.target);
    if (!node || node.kind !== 'file') return;
    select(node, false);
    send('activate', node);
  });
  var NAVIGATION = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter'];
  tree.addEventListener('keydown', function (event) {
    if (NAVIGATION.indexOf(event.key) < 0) return;
    var list = rows();
    var index = list.indexOf(selected);
    var next = null;
    switch (event.key) {
      case 'ArrowDown': next = list[Math.min(index + 1, list.length - 1)]; break;
      case 'ArrowUp': next = list[Math.max(index - 1, 0)]; break;
      case 'Home': next = list[0]; break;
      case 'End': next = list[list.length - 1]; break;
      case 'ArrowRight':
        if (selected && selected.kind === 'dir' && !selected.expanded) toggle(selected, true);
        else if (selected && list[index + 1] && list[index + 1].parent === selected) next = list[index + 1];
        break;
      case 'ArrowLeft':
        if (selected && selected.kind === 'dir' && selected.expanded) toggle(selected, false);
        else if (selected && selected.parent !== root) next = selected.parent;
        break;
      case 'Enter':
        if (selected && selected.kind === 'dir') toggle(selected);
        else if (selected && selected.kind === 'file') { clearTimeout(previewTimer); send('activate', selected); }
        break;
    }
    event.preventDefault();
    if (next && next !== selected) select(next, 'settle');
  });
  function setShowIgnored(value) {
    showIgnored = value;
    show.setAttribute('aria-pressed', String(showIgnored));
    tree.classList.toggle('hide-ignored', !showIgnored);
    if (selected && hidden(selected)) select(null, false);
    reportState();
  }
  show.addEventListener('click', function () { setShowIgnored(!showIgnored); });
  document.getElementById('refresh').addEventListener('click', function () {
    status.textContent = '';
    refresh().catch(fail);
  });
  document.getElementById('collapse').addEventListener('click', function () {
    root.children.forEach(function walk(node) {
      if (node.kind === 'dir') { toggle(node, false); node.children.forEach(walk); }
    });
    tree.focus();
  });
  load(root).then(function () {
    return request('state').then(restore, function () {});
  }).catch(fail);
})();`;

/** The folder viewer's one page. Entry names reach the DOM only through
 * `textContent`; the root's path is escaped into the markup. */
export function folderViewerPage(root: string): string {
  const name = escapeHtml(viewerTitle(root));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${name}</title><style>${STYLE}</style></head>`
    + `<body><header><span id="root" title="${escapeHtml(root)}">${name}</span>`
    + '<button type="button" id="show" aria-pressed="true" title="Show ignored files">Ignored</button><button type="button" id="collapse" aria-label="Collapse all folders" title="Collapse all folders"><svg viewBox="0 0 16 16"><path d="M3 1h11l1 1v10h-1V2H3zM1 4h11l1 1v9l-1 1H1l-1-1V5zm0 1v9h11V5zm2 4V8h7v1z"/></svg></button><button type="button" id="refresh" aria-label="Refresh" title="Refresh"><svg viewBox="0 0 16 16"><path d="M13 2v4H9l1.5-1.5A4.5 4.5 0 1 0 12.4 9h1A5.5 5.5 0 1 1 11.2 3.8z"/></svg></button></header>'
    + `<ul id="tree" role="tree" tabindex="0" aria-label="${name}"></ul><div id="status" role="status"></div><script>${SCRIPT}</script></body></html>`;
}
