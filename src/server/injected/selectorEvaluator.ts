/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CSSComplexSelector, CSSSimpleSelector, CSSComplexSelectorList, CSSFunctionArgument } from '../common/cssParser';

export type QueryContext = {
  scope: Element | Document;
  pierceShadow: boolean;
  // Place for more options, e.g. normalizing whitespace.
};
export type Selector = any; // Opaque selector type.
export interface SelectorEvaluator {
  query(context: QueryContext, selector: Selector): Element[];
  matches(element: Element, selector: Selector, context: QueryContext): boolean;
}
export interface SelectorEngine {
  matches?(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean;
  query?(context: QueryContext, args: (string | number | Selector)[], evaluator: SelectorEvaluator): Element[];
}

type QueryCache = Map<any, { rest: any[], result: any }[]>;
export class SelectorEvaluatorImpl implements SelectorEvaluator {
  private _engines = new Map<string, SelectorEngine>();
  private _cacheQueryCSS: QueryCache = new Map();
  private _cacheMatches: QueryCache = new Map();
  private _cacheQuery: QueryCache = new Map();
  private _cacheMatchesSimple: QueryCache = new Map();
  private _cacheMatchesParents: QueryCache = new Map();
  private _cacheCallMatches: QueryCache = new Map();
  private _cacheCallQuery: QueryCache = new Map();
  private _cacheQuerySimple: QueryCache = new Map();

  constructor(extraEngines: Map<string, SelectorEngine>) {
    // Note: keep predefined names in sync with Selectors class.
    for (const [name, engine] of extraEngines)
      this._engines.set(name, engine);
    this._engines.set('not', notEngine);
    this._engines.set('is', isEngine);
    this._engines.set('where', isEngine);
    this._engines.set('has', hasEngine);
    this._engines.set('scope', scopeEngine);
    this._engines.set('light', lightEngine);
    this._engines.set('index', indexEngine);
    this._engines.set('visible', visibleEngine);
    this._engines.set('text', textEngine);
    this._engines.set('matches-text', matchesTextEngine);
    this._engines.set('xpath', xpathEngine);
    for (const attr of ['id', 'data-testid', 'data-test-id', 'data-test'])
      this._engines.set(attr, createAttributeEngine(attr));
    this._engines.set('right-of', createProximityEngine('right-of', boxRightOf));
    this._engines.set('left-of', createProximityEngine('left-of', boxLeftOf));
    this._engines.set('above', createProximityEngine('above', boxAbove));
    this._engines.set('below', createProximityEngine('below', boxBelow));
    this._engines.set('near', createProximityEngine('near', boxNear));
    this._engines.set('within', createProximityEngine('within', boxWithin));
  }

  // This is the only function we should use for querying, because it does
  // the right thing with caching.
  evaluate(context: QueryContext, s: CSSComplexSelectorList): Element[] {
    const result = this.query(context, s);
    this._cacheQueryCSS.clear();
    this._cacheMatches.clear();
    this._cacheQuery.clear();
    this._cacheMatchesSimple.clear();
    this._cacheMatchesParents.clear();
    this._cacheCallMatches.clear();
    this._cacheCallQuery.clear();
    this._cacheQuerySimple.clear();
    return result;
  }

  private _cached<T>(cache: QueryCache, main: any, rest: any[], cb: () => T): T {
    if (!cache.has(main))
      cache.set(main, []);
    const entries = cache.get(main)!;
    const entry = entries.find(e => rest.every((value, index) => e.rest[index] === value));
    if (entry)
      return entry.result as T;
    const result = cb();
    entries.push({ rest, result });
    return result;
  }

  private _checkSelector(s: Selector): CSSComplexSelector | CSSComplexSelectorList {
    const wellFormed = typeof s === 'object' && s &&
      (Array.isArray(s) || ('simples' in s) && (s.simples.length));
    if (!wellFormed)
      throw new Error(`Malformed selector "${s}"`);
    return s as CSSComplexSelector | CSSComplexSelectorList;
  }

  matches(element: Element, s: Selector, context: QueryContext): boolean {
    const selector = this._checkSelector(s);
    return this._cached<boolean>(this._cacheMatches, element, [selector, context], () => {
      if (Array.isArray(selector))
        return this._matchesEngine(isEngine, element, selector, context);
      if (!this._matchesSimple(element, selector.simples[selector.simples.length - 1].selector, context))
        return false;
      return this._matchesParents(element, selector, selector.simples.length - 2, context);
    });
  }

  query(context: QueryContext, s: any): Element[] {
    const selector = this._checkSelector(s);
    return this._cached<Element[]>(this._cacheQuery, selector, [context], () => {
      if (Array.isArray(selector))
        return this._queryEngine(isEngine, context, selector);
      const elements = this._querySimple(context, selector.simples[selector.simples.length - 1].selector);
      return elements.filter(element => this._matchesParents(element, selector, selector.simples.length - 2, context));
    });
  }

  private _matchesSimple(element: Element, simple: CSSSimpleSelector, context: QueryContext): boolean {
    return this._cached<boolean>(this._cacheMatchesSimple, element, [simple, context], () => {
      const isScopeClause = simple.functions.some(f => f.name === 'scope');
      if (!isScopeClause && element === context.scope)
        return false;
      if (simple.css && !this._matchesCSS(element, simple.css))
        return false;
      for (const func of simple.functions) {
        if (!this._matchesEngine(this._getEngine(func.name), element, func.args, context))
          return false;
      }
      return true;
    });
  }

  private _querySimple(context: QueryContext, simple: CSSSimpleSelector): Element[] {
    if (!simple.functions.length)
      return this._queryCSS(context, simple.css || '*');

    return this._cached<Element[]>(this._cacheQuerySimple, simple, [context], () => {
      let css = simple.css;
      const funcs = simple.functions;
      if (css === '*' && funcs.length)
        css = undefined;

      let elements: Element[];
      let firstIndex = -1;
      if (css !== undefined) {
        elements = this._queryCSS(context, css);
      } else {
        firstIndex = funcs.findIndex(func => this._getEngine(func.name).query !== undefined);
        if (firstIndex === -1)
          firstIndex = 0;
        elements = this._queryEngine(this._getEngine(funcs[firstIndex].name), context, funcs[firstIndex].args);
      }
      for (let i = 0; i < funcs.length; i++) {
        if (i === firstIndex)
          continue;
        const engine = this._getEngine(funcs[i].name);
        if (engine.matches !== undefined)
          elements = elements.filter(e => this._matchesEngine(engine, e, funcs[i].args, context));
      }
      for (let i = 0; i < funcs.length; i++) {
        if (i === firstIndex)
          continue;
        const engine = this._getEngine(funcs[i].name);
        if (engine.matches === undefined)
          elements = elements.filter(e => this._matchesEngine(engine, e, funcs[i].args, context));
      }
      return elements;
    });
  }

  private _matchesParents(element: Element, complex: CSSComplexSelector, index: number, context: QueryContext): boolean {
    if (index < 0)
      return true;
    return this._cached<boolean>(this._cacheMatchesParents, element, [complex, index, context], () => {
      const { selector: simple, combinator } = complex.simples[index];
      if (combinator === '>') {
        const parent = parentElementOrShadowHostInContext(element, context);
        if (!parent || !this._matchesSimple(parent, simple, context))
          return false;
        return this._matchesParents(parent, complex, index - 1, context);
      }
      if (combinator === '+') {
        const previousSibling = previousSiblingInContext(element, context);
        if (!previousSibling || !this._matchesSimple(previousSibling, simple, context))
          return false;
        return this._matchesParents(previousSibling, complex, index - 1, context);
      }
      if (combinator === '') {
        let parent = parentElementOrShadowHostInContext(element, context);
        while (parent) {
          if (this._matchesSimple(parent, simple, context)) {
            if (this._matchesParents(parent, complex, index - 1, context))
              return true;
            if (complex.simples[index - 1].combinator === '')
              break;
          }
          parent = parentElementOrShadowHostInContext(parent, context);
        }
        return false;
      }
      if (combinator === '~') {
        let previousSibling = previousSiblingInContext(element, context);
        while (previousSibling) {
          if (this._matchesSimple(previousSibling, simple, context)) {
            if (this._matchesParents(previousSibling, complex, index - 1, context))
              return true;
            if (complex.simples[index - 1].combinator === '~')
              break;
          }
          previousSibling = previousSiblingInContext(previousSibling, context);
        }
        return false;
      }
      throw new Error(`Unsupported combinator "${combinator}"`);
    });
  }

  private _matchesEngine(engine: SelectorEngine, element: Element, args: CSSFunctionArgument[], context: QueryContext): boolean {
    if (engine.matches)
      return this._callMatches(engine, element, args, context);
    if (engine.query)
      return this._callQuery(engine, args, context).includes(element);
    throw new Error(`Selector engine should implement "matches" or "query"`);
  }

  private _queryEngine(engine: SelectorEngine, context: QueryContext, args: CSSFunctionArgument[]): Element[] {
    if (engine.query)
      return this._callQuery(engine, args, context);
    if (engine.matches)
      return this._queryCSS(context, '*').filter(element => this._callMatches(engine, element, args, context));
    throw new Error(`Selector engine should implement "matches" or "query"`);
  }

  private _callMatches(engine: SelectorEngine, element: Element, args: CSSFunctionArgument[], context: QueryContext): boolean {
    return this._cached<boolean>(this._cacheCallMatches, element, [engine, args, context.scope, context.pierceShadow], () => {
      return engine.matches!(element, args, context, this);
    });
  }

  private _callQuery(engine: SelectorEngine, args: CSSFunctionArgument[], context: QueryContext): Element[] {
    return this._cached<Element[]>(this._cacheCallQuery, args, [engine, context.scope, context.pierceShadow], () => {
      return engine.query!(context, args, this);
    });
  }

  private _matchesCSS(element: Element, css: string): boolean {
    return element.matches(css);
  }

  _queryCSS(context: QueryContext, css: string): Element[] {
    return this._cached<Element[]>(this._cacheQueryCSS, css, [context], () => {
      let result: Element[] = [];
      function query(root: Element | ShadowRoot | Document) {
        result = result.concat([...root.querySelectorAll(css)]);
        if (!context.pierceShadow)
          return;
        if ((root as Element).shadowRoot)
          query((root as Element).shadowRoot!);
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot)
            query(element.shadowRoot);
        }
      }
      query(context.scope);
      return result;
    });
  }

  private _getEngine(name: string): SelectorEngine {
    const engine = this._engines.get(name);
    if (!engine)
      throw new Error(`Unknown selector engine "${name}"`);
    return engine;
  }
}

const isEngine: SelectorEngine = {
  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    if (args.length === 0)
      throw new Error(`"is" engine expects non-empty selector list`);
    return args.some(selector => evaluator.matches(element, selector, context));
  },

  query(context: QueryContext, args: (string | number | Selector)[], evaluator: SelectorEvaluator): Element[] {
    if (args.length === 0)
      throw new Error(`"is" engine expects non-empty selector list`);
    let elements: Element[] = [];
    for (const arg of args)
      elements = elements.concat(evaluator.query(context, arg));
    return args.length === 1 ? elements : sortInDOMOrder(elements);
  },
};

const hasEngine: SelectorEngine = {
  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    if (args.length === 0)
      throw new Error(`"has" engine expects non-empty selector list`);
    return evaluator.query({ ...context, scope: element }, args).length > 0;
  },

  // TODO: we do not implement "relative selectors", as in "div:has(> span)" or "div:has(+ span)".

  // TODO: we can implement efficient "query" by matching "args" and returning
  // all parents/descendants, just have to be careful with the ":scope" matching.
};

const scopeEngine: SelectorEngine = {
  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    if (args.length !== 0)
      throw new Error(`"scope" engine expects no arguments`);
    if (context.scope.nodeType === 9 /* Node.DOCUMENT_NODE */)
      return element === (context.scope as Document).documentElement;
    return element === context.scope;
  },

  query(context: QueryContext, args: (string | number | Selector)[], evaluator: SelectorEvaluator): Element[] {
    if (args.length !== 0)
      throw new Error(`"scope" engine expects no arguments`);
    if (context.scope.nodeType === 9 /* Node.DOCUMENT_NODE */) {
      const root = (context.scope as Document).documentElement;
      return root ? [root] : [];
    }
    if (context.scope.nodeType === 1 /* Node.ELEMENT_NODE */)
      return [context.scope as Element];
    return [];
  },
};

const notEngine: SelectorEngine = {
  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    if (args.length === 0)
      throw new Error(`"not" engine expects non-empty selector list`);
    return !evaluator.matches(element, args, context);
  },
};

const lightEngine: SelectorEngine = {
  query(context: QueryContext, args: (string | number | Selector)[], evaluator: SelectorEvaluator): Element[] {
    return evaluator.query({ ...context, pierceShadow: false }, args);
  },

  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    return evaluator.matches(element, args, { ...context, pierceShadow: false });
  }
};

const indexEngine: SelectorEngine = {
  query(context: QueryContext, args: (string | number | Selector)[], evaluator: SelectorEvaluator): Element[] {
    if (args.length < 2 || typeof args[0] !== 'number')
      throw new Error(`"index" engine expects a number and non-empty selector list`);
    const list = evaluator.query(context, args.slice(1));
    const index = (args[0] as number) - 1;
    return [list[index]];
  },
};

const visibleEngine: SelectorEngine = {
  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    if (args.length)
      throw new Error(`"visible" engine expects no arguments`);
    return isVisible(element);
  }
};

const textEngine: SelectorEngine = {
  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    if (args.length === 0 || typeof args[0] !== 'string' || args.length > 2 || (args.length === 2 && typeof args[1] !== 'string'))
      throw new Error(`"text" engine expects a string and an optional flags string`);
    const text = args[0];
    const flags = args.length === 2 ? args[1] : '';
    const matcher = textMatcher(text, flags);
    return elementMatchesText(element, context, matcher);
  },
};

const matchesTextEngine: SelectorEngine = {
  matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
    if (args.length === 0 || typeof args[0] !== 'string' || args.length > 2 || (args.length === 2 && typeof args[1] !== 'string'))
      throw new Error(`"matches-text" engine expects a regexp body and optional regexp flags`);
    const re = new RegExp(args[0], args.length === 2 ? args[1] : undefined);
    return elementMatchesText(element, context, s => re.test(s));
  },
};

function textMatcher(text: string, flags: string): (s: string) => boolean {
  const normalizeSpace = flags.includes('s');
  const lowerCase = flags.includes('i');
  const substring = flags.includes('g');
  if (normalizeSpace)
    text = text.trim().replace(/\s+/g, ' ');
  if (lowerCase)
    text = text.toLowerCase();
  return (s: string) => {
    if (normalizeSpace)
      s = s.trim().replace(/\s+/g, ' ');
    if (lowerCase)
      s = s.toLowerCase();
    return substring ? s.includes(text) : s === text;
  };
}

function elementMatchesText(element: Element, context: QueryContext, matcher: (s: string) => boolean) {
  if (element.nodeName === 'SCRIPT' || element.nodeName === 'STYLE' || document.head && document.head.contains(element))
    return false;
  if ((element instanceof HTMLInputElement) && (element.type === 'submit' || element.type === 'button') && matcher(element.value))
    return true;
  let lastText = '';
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 /* Node.TEXT_NODE */) {
      lastText += child.nodeValue;
    } else {
      if (lastText && matcher(lastText))
        return true;
      lastText = '';
    }
  }
  return !!lastText && matcher(lastText);
}

const xpathEngine: SelectorEngine = {
  query(context: QueryContext, args: (string | number | Selector)[], evaluator: SelectorEvaluator): Element[] {
    if (args.length !== 1 || typeof args[0] !== 'string')
      throw new Error(`"xpath" engine expects a single string`);
    const document = context.scope.nodeType === 9 /* Node.DOCUMENT_NODE */ ? context.scope as Document : context.scope.ownerDocument;
    if (!document)
      return [];
    const result: Element[] = [];
    const it = document.evaluate(args[0], context.scope, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);
    for (let node = it.iterateNext(); node; node = it.iterateNext()) {
      if (node.nodeType === 1 /* Node.ELEMENT_NODE */)
        result.push(node as Element);
    }
    return result;
  },
};

function createAttributeEngine(attr: string): SelectorEngine {
  return {
    matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
      if (args.length === 0 || typeof args[0] !== 'string')
        throw new Error(`"${attr}" engine expects a single string`);
      return element.getAttribute(attr) === args[0];
    },

    query(context: QueryContext, args: (string | number | Selector)[], evaluator: SelectorEvaluator): Element[] {
      if (args.length !== 1 || typeof args[0] !== 'string')
        throw new Error(`"${attr}" engine expects a single string`);
      const css = `[${attr}=${CSS.escape(args[0])}]`;
      return (evaluator as SelectorEvaluatorImpl)._queryCSS(context, css);
    },
  };
}

function areCloseRanges(from1: number, to1: number, from2: number, to2: number, threshold: number) {
  return to1 >= from2 - threshold && to2 >= from1 - threshold;
}

function boxSize(box: DOMRect) {
  return Math.sqrt(box.width * box.height);
}

function boxesProximityThreshold(box1: DOMRect, box2: DOMRect) {
  return (boxSize(box1) + boxSize(box2)) / 2;
}

function boxRightOf(box1: DOMRect, box2: DOMRect): boolean {
  // To the right, but not too far, and vertically intersects.
  const distance = box1.left - box2.right;
  return distance >= 0 && distance <= boxesProximityThreshold(box1, box2) &&
    areCloseRanges(box1.top, box1.bottom, box2.top, box2.bottom, 0);
}

function boxLeftOf(box1: DOMRect, box2: DOMRect): boolean {
  // To the left, but not too far, and vertically intersects.
  const distance = box2.left - box1.right;
  return distance >= 0 && distance <= boxesProximityThreshold(box1, box2) &&
    areCloseRanges(box1.top, box1.bottom, box2.top, box2.bottom, 0);
}

function boxAbove(box1: DOMRect, box2: DOMRect): boolean {
  // Above, but not too far, and horizontally intersects.
  const distance = box2.top - box1.bottom;
  return distance >= 0 && distance <= boxesProximityThreshold(box1, box2) &&
    areCloseRanges(box1.left, box1.right, box2.left, box2.right, 0);
}

function boxBelow(box1: DOMRect, box2: DOMRect): boolean {
  // Below, but not too far, and horizontally intersects.
  const distance = box1.top - box2.bottom;
  return distance >= 0 && distance <= boxesProximityThreshold(box1, box2) &&
    areCloseRanges(box1.left, box1.right, box2.left, box2.right, 0);
}

function boxWithin(box1: DOMRect, box2: DOMRect): boolean {
  return box1.left >= box2.left && box1.right <= box2.right && box1.top >= box2.top && box1.bottom <= box2.bottom;
}

function boxNear(box1: DOMRect, box2: DOMRect): boolean {
  const intersects = !(box1.left >= box2.right || box2.left >= box1.right || box1.top >= box2.bottom || box2.top >= box1.bottom);
  if (intersects)
    return false;
  const threshold = boxesProximityThreshold(box1, box2);
  return areCloseRanges(box1.left, box1.right, box2.left, box2.right, threshold) &&
    areCloseRanges(box1.top, box1.bottom, box2.top, box2.bottom, threshold);
}

function createProximityEngine(name: string, predicate: (box1: DOMRect, box2: DOMRect) => boolean): SelectorEngine {
  return {
    matches(element: Element, args: (string | number | Selector)[], context: QueryContext, evaluator: SelectorEvaluator): boolean {
      if (!args.length)
        throw new Error(`"${name}" engine expects a selector list`);
      const box = element.getBoundingClientRect();
      return evaluator.query(context, args).some(e => e !== element && predicate(box, e.getBoundingClientRect()));
    },
  };
}

export function parentElementOrShadowHost(element: Element): Element | undefined {
  if (element.parentElement)
    return element.parentElement;
  if (!element.parentNode)
    return;
  if (element.parentNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (element.parentNode as ShadowRoot).host)
    return (element.parentNode as ShadowRoot).host;
}

function parentElementOrShadowHostInContext(element: Element, context: QueryContext): Element | undefined {
  if (element === context.scope)
    return;
  if (!context.pierceShadow)
    return element.parentElement || undefined;
  return parentElementOrShadowHost(element);
}

function previousSiblingInContext(element: Element, context: QueryContext): Element | undefined {
  if (element === context.scope)
    return;
  return element.previousElementSibling || undefined;
}

export function isVisible(element: Element): boolean {
  // Note: this logic should be similar to waitForDisplayedAtStablePosition() to avoid surprises.
  if (!element.ownerDocument || !element.ownerDocument.defaultView)
    return true;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (!style || style.visibility === 'hidden')
    return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function sortInDOMOrder(elements: Element[]): Element[] {
  type SortEntry = { children: Element[], taken: boolean };

  const elementToEntry = new Map<Element, SortEntry>();
  const roots: Element[] = [];
  const result: Element[] = [];

  function append(element: Element): SortEntry {
    let entry = elementToEntry.get(element);
    if (entry)
      return entry;
    const parent = parentElementOrShadowHost(element);
    if (parent) {
      const parentEntry = append(parent);
      parentEntry.children.push(element);
    } else {
      roots.push(element);
    }
    entry = { children: [], taken: false };
    elementToEntry.set(element, entry);
    return entry;
  }
  elements.forEach(e => append(e).taken = true);

  function visit(element: Element) {
    const entry = elementToEntry.get(element)!;
    if (entry.taken)
      result.push(element);
    if (entry.children.length > 1) {
      const set = new Set(entry.children);
      entry.children = [];
      let child = element.firstElementChild;
      while (child && entry.children.length < set.size) {
        if (set.has(child))
          entry.children.push(child);
        child = child.nextElementSibling;
      }
      child = element.shadowRoot ? element.shadowRoot.firstElementChild : null;
      while (child && entry.children.length < set.size) {
        if (set.has(child))
          entry.children.push(child);
        child = child.nextElementSibling;
      }
    }
    entry.children.forEach(visit);
  }
  roots.forEach(visit);

  return result;
}
