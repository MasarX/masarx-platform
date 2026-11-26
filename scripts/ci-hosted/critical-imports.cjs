'use strict';
const { isBuiltin } = require('node:module');
const { posix } = require('node:path');
const { edgeSharedSource } = require('../edge/shared-layout.cjs');

const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const typeDeclaration = /\.d\.[cm]?ts$/;
const testFile = /\.(?:test|spec)\.[^.]+$/;
const isString = token => token && /^['"\x60]/.test(token);
const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;

function sourceTokens(text) {
  const tokens = [];
  const token = /\s+|#![^\r\n]*|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|[\p{ID_Start}$_][\p{ID_Continue}$]*|=>|\.\.\.|\?\.|[^\s]/guy;
  const regex = /\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/y;
  const templatePart = /(?:\\[\s\S]|[^$\x60\\]|\$(?!\{))*(\$\{|\x60)/y;
  const regexAfter = new Set(['(', '[', '{', '=', ':', ',', ';', '!', '?', '&', '|', '+', '-', '*', '~',
    '=>', 'return', 'throw', 'case', 'yield']);

  function scan(start, expression = false) {
    let braces = 0;
    let offset = start;
    while (offset < text.length) {
      token.lastIndex = offset;
      const value = token.exec(text)[0];
      offset = token.lastIndex;
      if (/^\s|^#!|^\/\/|^\/\*/.test(value)) continue;
      if (value === '/' && (!tokens.length || regexAfter.has(tokens.at(-1)))) {
        regex.lastIndex = offset - 1;
        if (regex.test(text)) {
          offset = regex.lastIndex;
          tokens.push('<regex>');
          continue;
        }
      }
      if (value === '\x60') {
        const start = offset - 1;
        let interpolated = false;
        for (;;) {
          templatePart.lastIndex = offset;
          const part = templatePart.exec(text);
          if (!part) throw new Error('Unterminated template literal');
          offset = templatePart.lastIndex;
          if (part[1] === '\x60') break;
          interpolated = true;
          tokens.push('(');
          offset = scan(offset, true);
          tokens.push(')');
        }
        tokens.push(interpolated ? '<template>' : text.slice(start, offset));
        continue;
      }
      if (expression && value === '}' && braces === 0) return offset;
      if (value === '{') braces++;
      if (value === '}') braces--;
      tokens.push(value);
    }
    if (expression) throw new Error('Unterminated template expression');
    return offset;
  }

  scan(0);
  return tokens;
}

function* literalImports(text) {
  const tokens = sourceTokens(text);
  for (const [index, kind] of tokens.entries()) {
    if (!['require', 'import', 'export'].includes(kind) || ['.', '?.'].includes(tokens[index - 1])) continue;
    let next = index + 1;
    if (kind !== 'export' && tokens[next] === '(') {
      const end = tokens[next + 2];
      if (isString(tokens[next + 1]) && (end === ')' || end === ',')) {
        yield [tokens[next + 1], kind];
      }
      continue;
    }
    if (kind === 'require') continue;
    if (kind === 'import' && isString(tokens[next])) {
      yield [tokens[next], kind];
      continue;
    }

    if (tokens[next] === 'type' && tokens[next + 1] !== 'from') next++;
    if (kind === 'import' && identifier.test(tokens[next] || '')) {
      next++;
      if (tokens[next] === ',') next++;
    }
    if (tokens[next] === '*') next += tokens[next + 1] === 'as' ? 3 : 1;
    if (tokens[next] === '{') {
      next = tokens.indexOf('}', next + 1);
      if (next === -1) continue;
      next++;
    }
    if (tokens[next] === 'from' && isString(tokens[next + 1])) {
      yield [tokens[next + 1], 'import'];
    }
  }
}

function pathMapping(specifier, mappings) {
  if (Object.hasOwn(mappings, specifier)) return [mappings[specifier], ''];
  const matches = Object.keys(mappings).flatMap(key => {
    const [prefix, suffix, extra] = key.split('*');
    if (suffix === undefined || extra !== undefined || !specifier.startsWith(prefix) ||
      !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) return [];
    return [{ key, prefix, suffix }];
  });
  matches.sort((left, right) => right.prefix.length - left.prefix.length || right.key.length - left.key.length);
  if (!matches.length) return [];
  const { key, prefix, suffix } = matches[0];
  return [mappings[key], specifier.slice(prefix.length, specifier.length - suffix.length)];
}

function localResolver(files, read) {
  const jsonCache = new Map();
  const json = filename => {
    if (!jsonCache.has(filename)) jsonCache.set(filename, JSON.parse(read(filename).replace(/^\uFEFF/, '')));
    return jsonCache.get(filename);
  };
  const workspaces = files.has('package.json') ? json('package.json').workspaces ?? [] : [];
  const packages = new Map();
  for (const filename of files) {
    if (!filename.endsWith('/package.json')) continue;
    const directory = posix.dirname(filename);
    const parts = directory.split('/');
    const workspace = workspaces.some(pattern => {
      const segments = pattern.split('/');
      return segments.length === parts.length && segments.every((part, index) => part === '*' || part === parts[index]);
    });
    if (!workspace) continue;
    const manifest = json(filename);
    if (!manifest.name || packages.has(manifest.name)) throw new Error('Invalid workspace package: ' + filename);
    packages.set(manifest.name, { directory, manifest });
  }

  function compilerOptions(config, loading = new Set()) {
    if (!files.has(config) || loading.has(config)) throw new Error('Cannot resolve compiler configuration: ' + config);
    const document = json(config);
    const directory = posix.dirname(config);
    const options = document.compilerOptions ?? {};
    const parent = document.extends;
    if (parent && (typeof parent !== 'string' || !parent.startsWith('.'))) {
      throw new Error('Unsupported compiler configuration inheritance: ' + config);
    }
    const inherited = parent ? compilerOptions(posix.join(directory, parent), new Set([...loading, config])) : {};
    const base = options.baseUrl === undefined ? inherited.base : posix.join(directory, options.baseUrl);
    return {
      base,
      mappings: options.paths ?? inherited.mappings ?? {},
      mappingBase: options.paths ? base ?? directory : inherited.mappingBase,
    };
  }

  function projectOptions(filename) {
    for (let directory = posix.dirname(filename);;) {
      const configs = ['tsconfig.json', 'jsconfig.json'].map(name => posix.join(directory, name));
      const config = configs.find(name => files.has(name));
      if (config) {
        for (const reference of json(config).references ?? []) {
          const target = posix.join(directory, reference.path);
          if (!target.endsWith('.json')) continue;
          const child = json(target);
          const includes = [...(child.files ?? []), ...(child.include ?? [])];
          if (includes.some(name => filename === posix.join(posix.dirname(target), name) ||
            filename.startsWith(posix.join(posix.dirname(target), name) + '/'))) return compilerOptions(target);
        }
        return compilerOptions(config);
      }
      if (directory === '.') return { mappings: {} };
      directory = posix.dirname(directory);
    }
  }

  function resolvePath(candidate, mode) {
    const generated = edgeSharedSource(candidate);
    if (generated) return files.has(generated) ? generated : undefined;
    if (mode === 'explicit') return files.has(candidate) ? candidate : undefined;
    const extensions = mode === 'require' ? ['.js', '.json', '.node'] : ['.ts', '.tsx', '.js', '.jsx', '.json'];
    if (mode === 'typescript') {
      const translated = {
        '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
      }[posix.extname(candidate)] ?? [];
      const typescript = translated.map(ext => candidate.slice(0, -posix.extname(candidate).length) + ext)
        .find(name => files.has(name));
      if (typescript) return typescript;
    }
    const file = [candidate, ...extensions.map(ext => candidate + ext)].find(name => files.has(name));
    if (file) return file;
    const manifest = posix.join(candidate, 'package.json');
    if (files.has(manifest) && typeof json(manifest).main === 'string') {
      const entry = posix.join(candidate, json(manifest).main);
      const main = [entry, ...extensions.map(ext => entry + ext), ...extensions.map(ext => posix.join(entry, 'index' + ext))]
        .find(name => files.has(name));
      if (main) return main;
    }
    return extensions.map(ext => posix.join(candidate, 'index' + ext)).find(name => files.has(name));
  }

  return (filename, specifier, syntax) => {
    if (isBuiltin(specifier) || /^(?:https?:|npm:|jsr:|data:)/.test(specifier)) return null;
    const mode = syntax === 'require' ? 'require'
      : /^(?:supabase\/functions\/)|\.[cm]js$/.test(filename) ? 'explicit' : 'typescript';
    const missing = () => { throw new Error('Unresolved local import ' + specifier + ' in ' + filename); };
    if (/^\.\.?(?:\/|$)/.test(specifier)) {
      return resolvePath(posix.join(posix.dirname(filename), specifier), mode) ?? missing();
    }
    if (/^(?:[./#]|file:)/.test(specifier) && !specifier.startsWith('@/')) missing();

    if (mode === 'typescript' || /\.(?:ts|tsx)$/.test(filename)) {
      const { base, mappings, mappingBase } = projectOptions(filename);
      const [targets, wildcard] = pathMapping(specifier, mappings);
      if (targets !== undefined) {
        for (const target of targets) {
          const resolved = resolvePath(posix.join(mappingBase, target.replace('*', wildcard)), 'typescript');
          if (resolved) return resolved;
        }
        missing();
      }
      if (base !== undefined) {
        const resolved = resolvePath(posix.join(base, specifier), 'typescript');
        if (resolved) return resolved;
      }
    }
    if (specifier.startsWith('@/')) missing();

    const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    const workspace = packages.get(name);
    if (!workspace) return null;
    const { directory, manifest } = workspace;
    const subpath = '.' + specifier.slice(name.length);
    const exports = typeof manifest.exports === 'string' ? { '.': manifest.exports } : manifest.exports;
    const [target, wildcard] = exports ? pathMapping(subpath, exports)
      : [subpath === '.' ? manifest.main ?? './index.js' : subpath, ''];
    if (typeof target !== 'string' || !target.startsWith('./')) missing();
    const candidate = posix.join(directory, target.replace('*', wildcard));
    if (!candidate.startsWith(directory + '/')) missing();
    return resolvePath(candidate, exports ? 'explicit' : mode) ?? missing();
  };
}

function criticalClosure(rootPatterns, trackedFiles, read, matchesPattern) {
  const files = new Set(trackedFiles);
  const resolve = localResolver(files, read);
  const roots = trackedFiles.filter(filename => sourceFile.test(filename) && !typeDeclaration.test(filename) &&
    !testFile.test(filename) && rootPatterns.some(pattern => matchesPattern(pattern, filename)));
  const reached = new Map(roots.map(filename => [filename, null]));

  function chain(filename) {
    const parent = reached.get(filename);
    return parent ? chain(parent) + ' -> ' + filename : filename;
  }

  for (const filename of reached.keys()) {
    if (/\.[jt]sx$/.test(filename)) throw new Error('UI component in critical import graph: ' + chain(filename));
    if (!sourceFile.test(filename)) continue;
    try {
      for (const [literal, syntax] of literalImports(read(filename))) {
        if (literal.includes('\\')) throw new Error('Unsupported escaped import specifier ' + literal + ' in ' + filename);
        const specifier = literal.slice(1, -1);
        if (/^(?:npm:)?react(?:\/|$)/.test(specifier)) throw new Error('React import ' + specifier + ' in ' + filename);
        const target = resolve(filename, specifier, syntax);
        if (target && !reached.has(target)) reached.set(target, filename);
      }
    } catch (error) {
      throw new Error(error.message + ' (critical import chain: ' + chain(filename) + ')');
    }
  }
  return { roots, files: [...reached.keys()] };
}

module.exports = { criticalClosure };
