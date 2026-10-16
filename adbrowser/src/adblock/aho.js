/**
 * Compact Aho–Corasick automaton used as the multi-pattern prefilter for generic network rules.
 *
 * Memory layout (all flat typed arrays, no per-node objects):
 *   head[node]      index of the first outgoing edge (-1 = none)
 *   edgeChar[e]     alphabet code of the edge
 *   edgeTo[e]       target node
 *   edgeNext[e]     next sibling edge
 *   fail[node]      failure link
 *   out[node]       index into outVal/outNext (-1 = no match here)
 *
 * Sibling lists are tiny (2–8 edges), so the linear scan beats a Map by a wide margin and
 * costs ~5 bytes per edge. Output lists already contain the merged failure-chain outputs, so
 * one scan over the haystack reports every rule whose anchor occurs anywhere in the URL.
 */

const ALPHA_BASE = 32;
const ALPHA_SIZE = 95; // printable ASCII 32..126

export class AhoCorasick {
  constructor() {
    this.nodes = 1;
    this.head = [-1];
    this.fail = [0];
    this.out = [-1];
    this.outVal = [];
    this.outNext = [];
    this.edgeChar = [];
    this.edgeTo = [];
    this.edgeNext = [];
    this.edgeHead = new Map(); // node -> last edge index (append order)
    this.patternCount = 0;
  }

  static code(ch) {
    const c = ch.charCodeAt(0);
    return c >= ALPHA_BASE && c < ALPHA_BASE + ALPHA_SIZE ? c - ALPHA_BASE + 1 : 0;
  }

  getEdge(node, code) {
    for (let e = this.head[node]; e !== -1; e = this.edgeNext[e]) {
      if (this.edgeChar[e] === code) return this.edgeTo[e];
    }
    return -1;
  }

  addNode() {
    const id = this.nodes++;
    this.head.push(-1);
    this.fail.push(0);
    this.out.push(-1);
    return id;
  }

  addEdge(from, code, to) {
    const e = this.edgeChar.length;
    this.edgeChar.push(code);
    this.edgeTo.push(to);
    const last = this.edgeHead.get(from);
    if (last === undefined) this.head[from] = e;
    else this.edgeNext[last] = e;
    this.edgeNext.push(-1);
    this.edgeHead.set(from, e);
  }

  /** @param {string} pattern @param {number} id */
  add(pattern, id) {
    let node = 0;
    for (let i = 0; i < pattern.length; i++) {
      const code = AhoCorasick.code(pattern[i]);
      if (code === 0) return false; // unsupported char: skip this pattern entirely
      let next = this.getEdge(node, code);
      if (next === -1) {
        next = this.addNode();
        this.addEdge(node, code, next);
      }
      node = next;
    }
    const o = this.outVal.length;
    this.outVal.push(id);
    this.outNext.push(this.out[node]);
    this.out[node] = o;
    this.patternCount++;
    return true;
  }

  build() {
    const queue = [];
    for (let e = this.head[0]; e !== -1; e = this.edgeNext[e]) {
      const child = this.edgeTo[e];
      this.fail[child] = 0;
      queue.push(child);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const node = queue[qi];
      for (let e = this.head[node]; e !== -1; e = this.edgeNext[e]) {
        const code = this.edgeChar[e];
        const child = this.edgeTo[e];
        queue.push(child);
        let f = this.fail[node];
        while (f && this.getEdge(f, code) === -1) f = this.fail[f];
        const target = f === 0 ? (this.getEdge(0, code) ?? -1) : this.getEdge(f, code);
        const link = target !== -1 && target !== child ? target : 0;
        this.fail[child] = link;
        // merge outputs of the failure node
        for (let o = this.out[link]; o !== -1; o = this.outNext[o]) {
          const n = this.outVal.length;
          this.outVal.push(this.outVal[o]);
          this.outNext.push(this.out[child]);
          this.out[child] = n;
        }
      }
    }
    // freeze into typed arrays
    this.head = Int32Array.from(this.head);
    this.fail = Int32Array.from(this.fail);
    this.out = Int32Array.from(this.out);
    this.outVal = Int32Array.from(this.outVal);
    this.outNext = Int32Array.from(this.outNext);
    this.edgeChar = Uint8Array.from(this.edgeChar);
    this.edgeTo = Int32Array.from(this.edgeTo);
    this.edgeNext = Int32Array.from(this.edgeNext);
    this.edgeHead = null;
    this.nodes = this.head.length;
    return this;
  }

  /**
   * Call `cb(ruleId)` for every pattern that occurs in `text`.
   * @returns {number} number of callbacks
   */
  scan(text, cb) {
    let node = 0;
    let hits = 0;
    const head = this.head;
    const edgeChar = this.edgeChar;
    const edgeTo = this.edgeTo;
    const edgeNext = this.edgeNext;
    const fail = this.fail;
    const out = this.out;
    const outVal = this.outVal;
    const outNext = this.outNext;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const code = c >= ALPHA_BASE && c < ALPHA_BASE + ALPHA_SIZE ? c - ALPHA_BASE + 1 : 0;
      let next = code === 0 ? -1 : getEdge(head, edgeChar, edgeTo, edgeNext, node, code);
      while (next === -1 && node !== 0) {
        node = fail[node];
        next = getEdge(head, edgeChar, edgeTo, edgeNext, node, code);
      }
      if (next !== -1) node = next;
      for (let o = out[node]; o !== -1; o = outNext[o]) { hits++; cb(outVal[o]); }
    }
    return hits;
  }

  get memory() {
    return {
      nodes: this.nodes,
      edges: this.edgeChar.length,
      patterns: this.patternCount,
      bytes: (this.head.length + this.fail.length + this.out.length + this.outVal.length + this.outNext.length + this.edgeTo.length + this.edgeNext.length) * 4 + this.edgeChar.length,
    };
  }
}

function getEdge(head, edgeChar, edgeTo, edgeNext, node, code) {
  if (code === 0) return -1;
  for (let e = head[node]; e !== -1; e = edgeNext[e]) {
    if (edgeChar[e] === code) return edgeTo[e];
  }
  return -1;
}

/**
 * @param {Iterable<[string, number[]]>|Map<string, number[]>} anchorMap anchor -> rule ids
 */
export function buildFromMap(anchorMap) {
  const ac = new AhoCorasick();
  for (const [anchor, ids] of anchorMap) {
    if (!anchor) continue; // "always" bucket is handled by the caller
    for (const id of ids) ac.add(anchor, id);
  }
  return ac.build();
}
