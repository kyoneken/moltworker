import { runPython } from './python.mjs';
import { createHash } from 'node:crypto';

const FORBIDDEN_POINTER_PARTS = new Set(['__proto__', 'constructor', 'prototype']);
const OPERATION_KINDS = new Set(['json-key', 'json-array', 'markdown-block', 'toml-block', 'path']);
const fail = (code) => { throw new Error(code); };
const hash = (value) => createHash('sha256').update(value).digest('hex');

function jsonClone(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail('invalid-config');
    return JSON.parse(serialized);
  } catch (error) {
    if (error?.message === 'invalid-config') throw error;
    fail('invalid-config');
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid-config');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') fail('invalid-config');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const sameJson = (left, right) => canonicalJson(left) === canonicalJson(right);
const encodePointerPart = (part) => part.replaceAll('~', '~0').replaceAll('/', '~1');

function safePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) fail('invalid-config');
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) fail('invalid-config');
  return path;
}

function pointerParts(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/' || /~(?:[^01]|$)/.test(pointer)) fail('invalid-config');
  const parts = pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (parts.some((part) => part.length === 0 || FORBIDDEN_POINTER_PARTS.has(part))) fail('invalid-config');
  return parts;
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) || !OPERATION_KINDS.has(operation.kind)) fail('invalid-config');
  const normalized = { kind: operation.kind, path: safePath(operation.path) };
  if (operation.kind === 'json-key' || operation.kind === 'json-array') {
    normalized.pointer = operation.pointer;
    pointerParts(normalized.pointer);
    normalized.desired = jsonClone(operation.desired);
    canonicalJson(normalized.desired);
    if (operation.kind === 'json-array') {
      if (!Array.isArray(normalized.desired) || normalized.desired.length === 0) fail('invalid-config');
      const values = normalized.desired.map(canonicalJson);
      if (new Set(values).size !== values.length) fail('invalid-config');
    }
  } else {
    if (typeof operation.desired !== 'string') fail('invalid-config');
    normalized.desired = operation.desired;
  }
  if (operation.kind === 'markdown-block' || operation.kind === 'toml-block') {
    if (typeof operation.marker !== 'string' || !/^[A-Za-z0-9._-]+$/.test(operation.marker)) fail('invalid-config');
    normalized.marker = operation.marker;
    if (operation.desired.includes(`harness:${operation.marker}:`)) fail('invalid-config');
  }
  return normalized;
}

function operationIdentity(operation) {
  return `${operation.kind}\0${operation.path}\0${operation.pointer ?? operation.marker ?? ''}`;
}

function normalizeOperations(operations) {
  if (!Array.isArray(operations)) fail('invalid-config');
  const normalized = operations.map(normalizeOperation);
  const identities = normalized.map(operationIdentity);
  if (new Set(identities).size !== identities.length) fail('invalid-config');
  return normalized;
}

function cloneFiles(inputFiles) {
  if (!Array.isArray(inputFiles)) fail('invalid-config');
  const seen = new Set();
  return inputFiles.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file.path !== 'string' || typeof file.text !== 'string' || seen.has(file.path)) fail('invalid-config');
    seen.add(file.path);
    return { path: file.path, text: file.text, missing: file.missing === true };
  });
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-config');
    return value;
  } catch (error) {
    if (error?.message === 'invalid-config') throw error;
    fail('invalid-config');
  }
}

const serializeJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function resolveJsonTarget(root, pointer, create) {
  const parts = pointerParts(pointer);
  let cursor = root;
  const createdParents = [];
  const traversed = [];
  for (const part of parts.slice(0, -1)) {
    traversed.push(part);
    if (!Object.hasOwn(cursor, part)) {
      if (!create) return null;
      cursor[part] = {};
      createdParents.push(`/${traversed.map(encodePointerPart).join('/')}`);
    } else if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      fail('conflict');
    }
    cursor = cursor[part];
  }
  return { parent: cursor, key: parts.at(-1), createdParents };
}

function parentAt(root, pointer) {
  const parts = pointerParts(`${pointer}/child`).slice(0, -1);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.hasOwn(cursor, part)) return null;
    cursor = cursor[part];
  }
  return { parent: cursor, key: parts.at(-1) };
}

function cleanCreatedParents(root, createdParents) {
  for (const pointer of [...createdParents].reverse()) {
    const target = parentAt(root, pointer);
    if (!target || !Object.hasOwn(target.parent, target.key)) continue;
    const value = target.parent[target.key];
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) delete target.parent[target.key];
  }
}

function validateToml(text) {
  const result = runPython('import sys,tomllib; tomllib.loads(sys.stdin.read())', text);
  if (result.error || result.status !== 0) fail('invalid-config');
}

function blockParts(operation) {
  const comment = operation.kind === 'toml-block'
    ? (value) => `# harness:${operation.marker}:${value}`
    : (value) => `<!-- harness:${operation.marker}:${value} -->`;
  const core = `${comment('start')}\n${operation.desired}\n${comment('end')}`;
  return { core, token: `harness:${operation.marker}:` };
}

function findOwnedBlock(text, operation, stateEntry) {
  const { core, token } = blockParts(operation);
  if (text.split(token).length - 1 !== 2) fail('conflict');
  const insertion = `${stateEntry.blockPrefix ?? ''}${core}\n`;
  const offset = text.indexOf(insertion);
  if (offset < 0 || text.indexOf(insertion, offset + 1) >= 0) fail('conflict');
  if (hash(core) !== stateEntry.afterHash) fail('invalid-config');
  return { offset, insertion };
}

function entryFor(operation, details = {}) {
  const entry = { ...operation, ...details };
  if (operation.kind === 'json-key') entry.afterHash = hash(canonicalJson(operation.desired));
  if (operation.kind === 'json-array') {
    entry.entryHashes = operation.desired.map((value) => hash(canonicalJson(value)));
    entry.afterHash = hash(canonicalJson(operation.desired));
  }
  if (operation.kind === 'path') entry.afterHash = hash(operation.desired);
  if (operation.kind === 'markdown-block' || operation.kind === 'toml-block') entry.afterHash = hash(blockParts(operation).core);
  return entry;
}

function validateStateEntry(raw) {
  const operation = normalizeOperation(raw);
  const details = {};
  if (operation.kind === 'json-key' || operation.kind === 'json-array') {
    if (!Array.isArray(raw.createdParents)) fail('invalid-config');
    details.createdParents = raw.createdParents.map((pointer) => {
      pointerParts(`${pointer}/child`);
      return pointer;
    });
  }
  if (operation.kind === 'markdown-block' || operation.kind === 'toml-block') {
    if (raw.blockPrefix !== '' && raw.blockPrefix !== '\n') fail('invalid-config');
    details.blockPrefix = raw.blockPrefix;
  }
  const entry = entryFor(operation, details);
  if (raw.createdFile !== undefined && raw.createdFile !== true && raw.createdFile !== false) fail('invalid-config');
  if (raw.createdFile === true) entry.createdFile = true;
  if (raw.afterHash !== entry.afterHash) fail('invalid-config');
  if (operation.kind === 'json-array') {
    if (!Array.isArray(raw.entryHashes) || raw.entryHashes.length !== entry.entryHashes.length || raw.entryHashes.some((value, index) => value !== entry.entryHashes[index])) fail('invalid-config');
  }
  return entry;
}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1 || !Array.isArray(state.operations)) fail('invalid-config');
  const operations = state.operations.map(validateStateEntry);
  const previousOperations = (state.previousOperations ?? []).map(validateStateEntry);
  if (new Set(operations.map(operationIdentity)).size !== operations.length || new Set(previousOperations.map(operationIdentity)).size !== previousOperations.length) fail('invalid-config');
  return { schemaVersion: 1, operations, previousOperations };
}

const findFile = (files, path) => files.find((file) => file.path === path);

function verifyOwned(files, entries) {
  for (const entry of entries) {
    const file = findFile(files, entry.path);
    if (!file) fail('conflict');
    if (entry.kind === 'path') {
      if (hash(file.text) !== entry.afterHash) fail('conflict');
      continue;
    }
    if (entry.kind === 'markdown-block' || entry.kind === 'toml-block') {
      if (entry.kind === 'toml-block') validateToml(file.text);
      findOwnedBlock(file.text, entry, entry);
      continue;
    }
    const json = parseJson(file.text);
    const target = resolveJsonTarget(json, entry.pointer, false);
    if (!target || !Object.hasOwn(target.parent, target.key)) fail('conflict');
    if (entry.kind === 'json-key') {
      if (hash(canonicalJson(target.parent[target.key])) !== entry.afterHash) fail('conflict');
    } else {
      const array = target.parent[target.key];
      if (!Array.isArray(array)) fail('conflict');
      for (const desired of entry.desired) {
        if (array.filter((value) => sameJson(value, desired)).length !== 1) fail('conflict');
      }
    }
  }
}

function removeOwned(files, entries) {
  for (const entry of [...entries].reverse()) {
    const file = findFile(files, entry.path);
    if (entry.kind === 'path') {
      files.splice(files.indexOf(file), 1);
      continue;
    }
    if (entry.kind === 'markdown-block' || entry.kind === 'toml-block') {
      const found = findOwnedBlock(file.text, entry, entry);
      file.text = file.text.slice(0, found.offset) + file.text.slice(found.offset + found.insertion.length);
      if (entry.kind === 'toml-block') validateToml(file.text);
      if (entry.createdFile && file.text.trim() === '') files.splice(files.indexOf(file), 1);
      continue;
    }
    const json = parseJson(file.text);
    const target = resolveJsonTarget(json, entry.pointer, false);
    if (entry.kind === 'json-key') delete target.parent[target.key];
    else {
      const owned = entry.desired.map(canonicalJson);
      target.parent[target.key] = target.parent[target.key].filter((value) => !owned.includes(canonicalJson(value)));
      if (target.parent[target.key].length === 0 && entry.createdParents.includes(entry.pointer)) delete target.parent[target.key];
    }
    cleanCreatedParents(json, entry.createdParents);
    file.text = serializeJson(json);
    if (entry.createdFile && Object.keys(json).length === 0) files.splice(files.indexOf(file), 1);
  }
}

function applyFresh(files, operations) {
  const entries = [];
  for (const operation of operations) {
    let file = findFile(files, operation.path);
    if (operation.kind === 'path') {
      if (file) fail('conflict');
      file = { path: operation.path, text: operation.desired };
      files.push(file);
      entries.push(entryFor(operation));
      continue;
    }
    const createdFile = !file || file.missing === true;
    if (!file) {
      if (operation.kind === 'markdown-block' || operation.kind === 'toml-block') file = { path: operation.path, text: '', missing: true };
      else file = { path: operation.path, text: '{}\n', missing: true };
      files.push(file);
    }
    file.missing = false;
    if (operation.kind === 'markdown-block' || operation.kind === 'toml-block') {
      if (operation.kind === 'toml-block') validateToml(file.text);
      const { core, token } = blockParts(operation);
      if (file.text.includes(token)) fail('conflict');
      const blockPrefix = file.text.length > 0 && !file.text.endsWith('\n') ? '\n' : '';
      const candidate = `${file.text}${blockPrefix}${core}\n`;
      if (operation.kind === 'toml-block') {
        validateToml(`${core}\n`);
        try { validateToml(candidate); } catch (error) { fail(error.message === 'missing-command' ? 'missing-command' : 'conflict'); }
      }
      file.text = candidate;
      entries.push(entryFor(operation, { blockPrefix, ...(createdFile ? { createdFile: true } : {}) }));
      continue;
    }
    const json = parseJson(file.text);
    const target = resolveJsonTarget(json, operation.pointer, true);
    if (operation.kind === 'json-key') {
      if (Object.hasOwn(target.parent, target.key)) fail('conflict');
      target.parent[target.key] = jsonClone(operation.desired);
    } else {
      if (!Object.hasOwn(target.parent, target.key)) {
        target.parent[target.key] = [];
        target.createdParents.push(operation.pointer);
      }
      const array = target.parent[target.key];
      if (!Array.isArray(array)) fail('conflict');
      for (const desired of operation.desired) if (array.some((value) => sameJson(value, desired))) fail('conflict');
      array.push(...jsonClone(operation.desired));
    }
    file.text = serializeJson(json);
    entries.push(entryFor(operation, { createdParents: target.createdParents, ...(createdFile ? { createdFile: true } : {}) }));
  }
  return entries;
}

function sameRequestedOperations(operations, entries) {
  return operations.length === entries.length && operations.every((operation, index) => {
    const entry = entries[index];
    return operationIdentity(operation) === operationIdentity(entry) && sameJson(operation.desired, entry.desired);
  });
}

export function applyOperations(inputFiles, operations, optionalPreviousState) {
  const files = cloneFiles(inputFiles);
  const requested = normalizeOperations(operations);
  const previousState = optionalPreviousState === undefined ? null : normalizeState(optionalPreviousState);
  if (previousState) {
    verifyOwned(files, previousState.operations);
    if (sameRequestedOperations(requested, previousState.operations)) return { files, state: jsonClone(previousState) };
    removeOwned(files, previousState.operations);
  }
  const applied = applyFresh(files, requested);
  return { files, state: { schemaVersion: 1, operations: applied, previousOperations: previousState ? jsonClone(previousState.operations) : [] } };
}

export function restoreOperations(inputFiles, state) {
  const files = cloneFiles(inputFiles);
  const normalizedState = normalizeState(state);
  verifyOwned(files, normalizedState.operations);
  removeOwned(files, normalizedState.operations);
  const restoredEntries = applyFresh(files, normalizedState.previousOperations.map(normalizeOperation));
  return { files, state: { schemaVersion: 1, operations: restoredEntries, previousOperations: [] } };
}
