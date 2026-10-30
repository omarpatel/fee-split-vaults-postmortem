/**
 * Aho-Corasick multi-pattern matcher.
 *
 * One linear pass over the folded skeleton finds every term at once, which is
 * what keeps stage 1 sub-millisecond on a full metadata blob regardless of how
 * many terms the operator loads. A per-term regex sweep would be O(terms x n)
 * and would put the cheapest stage on the critical path of every screening.
 */

export interface TermSpec {
  /** Raw term. Folded by the caller-supplied folder before compilation. */
  term: string
  /** Caller's identifier, returned on every hit. */
  id: string
}

export interface TermMatch {
  id: string
  term: string
  /** Half-open range in the FOLDED text. */
  start: number
  end: number
}

interface Node {
  next: Map<string, number>
  fail: number
  /** Indices into the compiled term table. */
  out: number[]
}

export class TermMatcher {
  private readonly nodes: Node[]
  private readonly terms: Array<{ id: string; term: string; folded: string }>

  private constructor(nodes: Node[], terms: Array<{ id: string; term: string; folded: string }>) {
    this.nodes = nodes
    this.terms = terms
  }

  static compile(specs: readonly TermSpec[], foldTerm: (s: string) => string): TermMatcher {
    const nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }]
    const terms: Array<{ id: string; term: string; folded: string }> = []

    for (const spec of specs) {
      const folded = foldTerm(spec.term)
      if (folded.length === 0) continue
      const index = terms.length
      terms.push({ id: spec.id, term: spec.term, folded })

      let current = 0
      for (const ch of folded) {
        const node = nodes[current]
        if (node === undefined) throw new Error('matcher: corrupt trie')
        let next = node.next.get(ch)
        if (next === undefined) {
          next = nodes.length
          nodes.push({ next: new Map(), fail: 0, out: [] })
          node.next.set(ch, next)
        }
        current = next
      }
      const terminal = nodes[current]
      if (terminal === undefined) throw new Error('matcher: corrupt trie')
      terminal.out.push(index)
    }

    // Breadth-first failure links; output sets inherit along them.
    const queue: number[] = []
    const root = nodes[0]
    if (root === undefined) throw new Error('matcher: corrupt trie')
    for (const child of root.next.values()) {
      const node = nodes[child]
      if (node === undefined) continue
      node.fail = 0
      queue.push(child)
    }
    for (let head = 0; head < queue.length; head += 1) {
      const currentIndex = queue[head]
      if (currentIndex === undefined) continue
      const current = nodes[currentIndex]
      if (current === undefined) continue
      for (const [ch, childIndex] of current.next) {
        const child = nodes[childIndex]
        if (child === undefined) continue
        let fallback = current.fail
        for (;;) {
          const node = nodes[fallback]
          if (node === undefined) break
          const candidate = node.next.get(ch)
          if (candidate !== undefined && candidate !== childIndex) {
            child.fail = candidate
            break
          }
          if (fallback === 0) {
            child.fail = 0
            break
          }
          fallback = node.fail
        }
        const failNode = nodes[child.fail]
        if (failNode !== undefined) child.out = [...child.out, ...failNode.out]
        queue.push(childIndex)
      }
    }

    return new TermMatcher(nodes, terms)
  }

  /** Every occurrence of every term in the folded text. */
  findAll(folded: string): TermMatch[] {
    const matches: TermMatch[] = []
    let state = 0
    let index = 0
    for (const ch of folded) {
      for (;;) {
        const node = this.nodes[state]
        if (node === undefined) {
          state = 0
          break
        }
        const next = node.next.get(ch)
        if (next !== undefined) {
          state = next
          break
        }
        if (state === 0) break
        state = node.fail
      }
      const node = this.nodes[state]
      if (node !== undefined) {
        for (const termIndex of node.out) {
          const term = this.terms[termIndex]
          if (term === undefined) continue
          matches.push({
            id: term.id,
            term: term.term,
            start: index + 1 - term.folded.length,
            end: index + 1,
          })
        }
      }
      index += 1
    }
    return matches
  }

  get size(): number {
    return this.terms.length
  }
}
