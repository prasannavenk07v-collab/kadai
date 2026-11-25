import { httpError } from '../../lib/auth.js';

// A deliberately small XML reader for Tally exports and XLSX sheets.
//
// It is not a general parser and should not become one. What it must do is
// refuse hostile input: no DTDs, no external entities, bounded depth, bounded
// nodes. Those limits are the security control in docs/m3-books-plan.md §9.

const MAX_DEPTH = 64;
const MAX_NODES = 200_000;

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (match) => ENTITIES[match]);
}

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    attrs[match[1]] = decodeEntities(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Parse a document into { name, attrs, children, text }.
 * Throws XML_UNSAFE for DTD/entity payloads and XML_MALFORMED for bad nesting.
 */
export function parseXml(input) {
  if (typeof input !== 'string') {
    throw httpError(400, 'XML_MALFORMED', 'Expected XML text.');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) {
    throw httpError(400, 'XML_UNSAFE', 'DTD and entity declarations are not accepted.');
  }

  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let index = 0;
  let nodeCount = 0;

  const appendText = (text) => {
    if (text) stack[stack.length - 1].text += decodeEntities(text);
  };

  while (index < input.length) {
    const lt = input.indexOf('<', index);
    if (lt === -1) {
      appendText(input.slice(index));
      break;
    }
    appendText(input.slice(index, lt));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) throw httpError(400, 'XML_MALFORMED', 'Unterminated comment.');
      index = end + 3;
      continue;
    }

    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end === -1) throw httpError(400, 'XML_MALFORMED', 'Unterminated CDATA section.');
      stack[stack.length - 1].text += input.slice(lt + 9, end);
      index = end + 3;
      continue;
    }

    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) throw httpError(400, 'XML_MALFORMED', 'Unterminated processing instruction.');
      index = end + 2;
      continue;
    }

    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) throw httpError(400, 'XML_MALFORMED', 'Unterminated tag.');

    const raw = input.slice(lt + 1, gt).trim();

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw httpError(400, 'XML_MALFORMED', `Unexpected closing tag </${name}>.`);
      }
      if (stack.length === 0) {
        throw httpError(400, 'XML_MALFORMED', 'Unexpected trailing content.');
      }
    } else {
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1).trim() : raw;
      const space = body.search(/\s/);
      const name = space === -1 ? body : body.slice(0, space);
      if (!name || !/^[\w:.-]+$/.test(name)) {
        throw httpError(400, 'XML_MALFORMED', `Invalid tag <${body}>.`);
      }

      const node = {
        name,
        attrs: space === -1 ? {} : parseAttributes(body.slice(space)),
        children: [],
        text: '',
      };

      nodeCount += 1;
      if (nodeCount > MAX_NODES) {
        throw httpError(400, 'XML_TOO_LARGE', `Report has more than ${MAX_NODES} elements.`);
      }
      if (stack.length >= MAX_DEPTH) {
        throw httpError(400, 'XML_TOO_DEEP', `Report nests deeper than ${MAX_DEPTH} elements.`);
      }

      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }

    index = gt + 1;
  }

  if (stack.length !== 1) {
    throw httpError(400, 'XML_MALFORMED', `Unclosed tag <${stack[stack.length - 1].name}>.`);
  }
  return root;
}

export function findAll(node, name, results = []) {
  if (!node) return results;
  for (const child of node.children) {
    if (child.name === name) results.push(child);
    findAll(child, name, results);
  }
  return results;
}

export function findFirst(node, name) {
  if (!node) return null;
  for (const child of node.children) {
    if (child.name === name) return child;
    const nested = findFirst(child, name);
    if (nested) return nested;
  }
  return null;
}

export function childText(node, name) {
  const child = findFirst(node, name);
  return child ? child.text.trim() : null;
}

export function collectText(node, parts = []) {
  if (!node) return parts;
  if (node.text) parts.push(node.text);
  for (const child of node.children) collectText(child, parts);
  return parts;
}
