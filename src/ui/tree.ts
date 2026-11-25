import type { Plan } from '../core';

type State = 'on' | 'off' | 'mixed';

interface TreeNode {
  kind: 'folder' | 'doc';
  /** Folder or document id; empty for the folders the tool makes up (such as the unfiled one). */
  id: string;
  name: string;
  children: TreeNode[];
  parent?: TreeNode;
  /** Documents, and folders that hold nothing: whether they are ticked. Other folders show what is below them. */
  checked: boolean;
  /** Set after the filter runs: whether the node is visible. */
  shown: boolean;
  li?: HTMLLIElement;
  input?: HTMLInputElement;
  list?: HTMLUListElement;
  twisty?: HTMLButtonElement;
  count?: HTMLElement;
}

export interface PlanTree {
  /** Ids to leave out of the export: unticked documents, and folders with nothing ticked inside. */
  excluded(): string[];
  counts(): { selected: number; total: number };
  setFilter(text: string): void;
  /** Ticks or unticks every document that is currently shown. */
  tickShown(on: boolean): void;
}

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const byKindThenName = (a: TreeNode, b: TreeNode): number =>
  (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * Draws the scanned plan as a tree of folders and documents with checkboxes (a folder ticks or unticks everything
 * below it) and a name filter. The tree shows where each document will be saved.
 */
export function renderPlanTree(container: HTMLElement, plan: Plan, excluded: ReadonlySet<string>, onChange: () => void): PlanTree {
  const root: TreeNode = { kind: 'folder', id: '', name: '', children: [], checked: true, shown: true };
  const byPath = new Map<string, TreeNode>([['', root]]);
  const planned = new Map(plan.folders.map((f) => [f.path, f]));
  const folderAt = (path: string): TreeNode => {
    const known = byPath.get(path);
    if (known) return known;
    const found = planned.get(path);
    const node: TreeNode = { kind: 'folder', id: found?.id ?? '', name: found?.title || basename(path), children: [], checked: !(found && excluded.has(found.id)), shown: true };
    const parent = folderAt(dirname(path));
    node.parent = parent;
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const folder of plan.folders) folderAt(folder.path);
  for (const t of plan.threads) {
    const parent = folderAt(t.folderPath);
    parent.children.push({ kind: 'doc', id: t.meta.id, name: t.meta.title.trim() || 'Untitled', children: [], parent, checked: !excluded.has(t.meta.id), shown: true });
  }

  const nodes: TreeNode[] = [];
  const sortAll = (node: TreeNode): void => {
    node.children.sort(byKindThenName);
    for (const c of node.children) sortAll(c);
  };
  sortAll(root);

  const docsBelow = (node: TreeNode): TreeNode[] => (node.kind === 'doc' ? [node] : node.children.flatMap(docsBelow));
  const stateOf = (node: TreeNode): State => {
    if (node.kind === 'doc' || node.children.length === 0) return node.checked ? 'on' : 'off';
    const states = node.children.map(stateOf);
    return states.every((s) => s === 'on') ? 'on' : states.every((s) => s === 'off') ? 'off' : 'mixed';
  };
  const setBelow = (node: TreeNode, on: boolean): void => {
    node.checked = on;
    for (const c of node.children) setBelow(c, on);
  };

  const toggle = (node: TreeNode, open: boolean): void => {
    if (!node.list || !node.twisty) return;
    node.list.hidden = !open;
    node.twisty.setAttribute('aria-expanded', String(open));
    node.twisty.textContent = open ? '▾' : '▸';
  };

  const build = (node: TreeNode, depth: number): HTMLLIElement => {
    const li = document.createElement('li');
    li.dataset.kind = node.kind;
    const row = document.createElement('div');
    row.className = 'node';
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.node = String(nodes.length);
    nodes.push(node);
    const name = document.createElement('span');
    name.textContent = node.name;
    name.title = node.name;
    const note = document.createElement('small');
    label.append(input, name, note);
    node.li = li;
    node.input = input;
    node.count = note;
    if (node.kind === 'folder' && node.children.length > 0) {
      const twisty = document.createElement('button');
      twisty.type = 'button';
      twisty.className = 'twisty';
      twisty.setAttribute('aria-label', `Show or hide what is in ${node.name}`);
      node.twisty = twisty;
      row.append(twisty, label);
      li.append(row);
      const list = document.createElement('ul');
      node.list = list;
      for (const c of node.children) list.append(build(c, depth + 1));
      li.append(list);
      toggle(node, depth === 0);
      twisty.addEventListener('click', () => toggle(node, list.hidden === true));
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      row.append(spacer, label);
      li.append(row);
    }
    return li;
  };

  const top = document.createElement('ul');
  for (const c of root.children) top.append(build(c, 0));
  container.replaceChildren(top);

  const total = nodes.filter((n) => n.kind === 'doc').length;
  const paint = (): void => {
    for (const node of nodes) {
      const state = stateOf(node);
      if (!node.input) continue;
      node.input.checked = state === 'on';
      node.input.indeterminate = state === 'mixed';
      if (node.kind === 'folder' && node.count) {
        const docs = docsBelow(node);
        node.count.textContent = docs.length > 0 ? `${docs.filter((d) => d.checked).length} of ${docs.length}` : '';
      } else if (node.count) node.count.textContent = '';
    }
  };
  paint();

  container.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const node = input.dataset.node === undefined ? undefined : nodes[Number(input.dataset.node)];
    if (!node) return;
    // A partly ticked folder becomes fully ticked when clicked, as in a file manager.
    setBelow(node, input.checked);
    paint();
    onChange();
  });

  const tree: PlanTree = {
    excluded() {
      const out: string[] = [];
      const walk = (node: TreeNode): void => {
        if (node.kind === 'doc') {
          if (!node.checked) out.push(node.id);
          return;
        }
        for (const c of node.children) walk(c);
        if (node.id && stateOf(node) === 'off') out.push(node.id);
      };
      walk(root);
      return out;
    },
    counts() {
      return { selected: nodes.filter((n) => n.kind === 'doc' && n.checked).length, total };
    },
    setFilter(text) {
      const needle = text.trim().toLowerCase();
      const visit = (node: TreeNode, ancestorMatches: boolean): boolean => {
        const own = needle !== '' && node.name.toLowerCase().includes(needle);
        let below = false;
        for (const c of node.children) if (visit(c, ancestorMatches || own)) below = true;
        node.shown = needle === '' || ancestorMatches || own || below;
        if (node.li) node.li.hidden = !node.shown;
        // Results are only useful if they can be seen, so folders with matches open.
        if (needle !== '' && (own || below) && node.list) toggle(node, true);
        return node.shown;
      };
      for (const c of root.children) visit(c, false);
    },
    tickShown(on) {
      for (const node of nodes) if (node.shown && (node.kind === 'doc' || node.children.length === 0)) node.checked = on;
      paint();
      onChange();
    },
  };
  return tree;
}
