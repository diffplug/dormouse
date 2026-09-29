import { basename } from 'node:path';
import { escapeHtml } from './file-viewer.js';

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:Canvas;color:CanvasText;font:13px/1.4 system-ui,sans-serif}
header{display:flex;align-items:center;gap:8px;padding:3px 8px;border-bottom:1px solid GrayText}
#root{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
label{display:flex;align-items:center;gap:4px;white-space:nowrap}
button,input{font:inherit;margin:0}
ul{margin:0;padding:0;list-style:none}
#tree{flex:1;overflow:auto;padding:2px 0;outline:none}
.row{display:flex;align-items:center;height:22px;padding-right:8px;white-space:nowrap;cursor:default;user-select:none}
.chev{flex:none;width:16px;text-align:center;font-size:10px}
[aria-expanded="true"]>.row>.chev{transform:rotate(90deg)}
[aria-expanded="false"]>ul{display:none}
.name{overflow:hidden;text-overflow:ellipsis}
.ignored>.row,.note{color:GrayText}
.note{height:22px;font-style:italic}
#tree.hide-ignored .ignored{display:none}
[aria-selected="true"]>.row{outline:1px solid Highlight;outline-offset:-1px}
#tree:focus [aria-selected="true"]>.row{outline:none;background:Highlight;color:HighlightText}
#status{padding:3px 8px;border-top:1px solid GrayText;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#status:empty{display:none}
`;

// Plain script inside a template literal: no backslashes, backticks, or interpolation.
const SCRIPT = `(function () {
  'use strict';
  var tree = document.getElementById('tree');
  var show = document.getElementById('show');
  var status = document.getElementById('status');
  var root = { path: '', kind: 'dir', level: 0, parent: null, children: [], group: tree, expanded: true, loaded: false };
  var nodes = new WeakMap();
  var selected = null;
  var nextId = 0;
  var previewTimer = 0;
  var sequence = 0;
  var selectsSettled = Promise.resolve(); // once every select sent so far has settled; never rejects

  function fail(error) { status.textContent = error && error.message ? error.message : String(error); }
  function indent(level) { return (4 + (level - 1) * 12) + 'px'; }
  function contains(ancestor, node) {
    for (var n = node; n; n = n.parent) if (n === ancestor) return true;
    return false;
  }
  function hidden(node) {
    for (var n = node; n && n !== root; n = n.parent) if (n.ignored && !show.checked) return true;
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
    row.appendChild(name);
    li.appendChild(row);
    var node = { name: entry.name, path: parent.path ? parent.path + '/' + entry.name : entry.name, kind: entry.kind,
      level: parent.level + 1, parent: parent, li: li, row: row, children: [], group: null, expanded: false, loaded: false };
    if (entry.kind === 'dir') {
      chev.textContent = '▸';
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
  }

  // The latest request alone owns the status line; a superseded preview is not an error.
  // Each POST is its own control connection, so an activate waits for every
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
    if (!node) { tree.removeAttribute('aria-activedescendant'); return; }
    node.li.setAttribute('aria-selected', 'true');
    tree.setAttribute('aria-activedescendant', node.li.id);
    node.row.scrollIntoView({ block: 'nearest' });
    if (node.kind !== 'file' || !preview) return;
    if (preview === 'now') send('select', node);
    else previewTimer = setTimeout(function () { send('select', node); }, 150);
  }

  // The walk descends only through shown rows, so a child is hidden by its own flag alone.
  function rows() {
    var out = [];
    (function walk(parent) {
      parent.children.forEach(function (child) {
        if (child.ignored && !show.checked) return;
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
  show.addEventListener('change', function () {
    tree.classList.toggle('hide-ignored', !show.checked);
    if (selected && hidden(selected)) select(null, false);
  });
  document.getElementById('refresh').addEventListener('click', function () {
    status.textContent = '';
    refresh().catch(fail);
  });
  load(root).catch(fail);
})();`;

/** The folder viewer's one page. Entry names reach the DOM only through
 * `textContent`; the root's path is escaped into the markup. */
export function folderViewerPage(root: string): string {
  const name = escapeHtml(basename(root) || root);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${name}</title><style>${STYLE}</style></head>`
    + `<body><header><span id="root" title="${escapeHtml(root)}">${name}</span>`
    + '<label><input type="checkbox" id="show" checked> Show ignored</label><button type="button" id="refresh">Refresh</button></header>'
    + `<ul id="tree" role="tree" tabindex="0" aria-label="${name}"></ul><div id="status" role="status"></div><script>${SCRIPT}</script></body></html>`;
}
