"""Bounded static import/script inventory; reads source, never imports/executes it."""
import argparse
import json
import re
import shlex
from pathlib import Path

ROOTS = ['scripts/ops/ci/cloud-pool-db-local.js', 'scripts/ops/ci/cloud-pool-db-local-pgtap.js',
         'scripts/ops/ci/supabase-cli-asset.js', 'scripts/tests/run-pgtap-cloud.js']
LOCAL = re.compile(r'''(?:require(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]\s*[,)]|(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))''')


def collect(root, entrypoints=None):
    root = root.resolve()
    unresolved = set()
    protected = set()
    closure = set()
    edges = []

    def resolve(base, spec):
        candidate = (base / spec).resolve()
        if not candidate.is_relative_to(root):
            return None
        options = [candidate, *[Path(str(candidate) + ext) for ext in ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json']]]
        if candidate.is_dir():
            manifest = candidate / 'package.json'
            if manifest.is_file():
                main = json.loads(manifest.read_text(encoding='utf-8-sig')).get('main')
                if isinstance(main, str):
                    options.append((candidate / main).resolve())
            options += [candidate / ('index' + ext) for ext in ['.js', '.cjs', '.mjs', '.ts', '.json']]
        for file in options:
            if file.is_relative_to(root) and file.is_file() and not file.is_symlink():
                return file.relative_to(root).as_posix()
        return None

    pending = list(ROOTS)
    while pending:
        name = pending.pop()
        if name in closure:
            continue
        file = root / name
        if not file.is_file():
            unresolved.add((name, 'missing backend root', name)); continue
        closure.add(name)
        if file.suffix == '.json':
            continue
        text = file.read_text(encoding='utf-8-sig')
        literal_starts = set()
        for match in LOCAL.finditer(text):
            literal_starts.add(match.start())
            spec = next(value for value in match.groups() if value is not None)
            if spec.startswith('.'):
                target = resolve(file.parent, spec)
                if target:
                    edges.append({'from': name, 'specifier': spec, 'to': target}); pending.append(target)
                else:
                    unresolved.add((name, 'unresolved local import', spec))
            elif not spec.startswith('node:') and spec not in {'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'dns', 'url', 'util', 'stream', 'events', 'assert', 'buffer', 'child_process', 'timers', 'zlib', 'module', 'worker_threads', 'process', 'readline'}:
                unresolved.add((name, 'external dependency import', spec))
        for match in re.finditer(r'\brequire(?:\.resolve)?\s*\(', text):
            if match.start() not in literal_starts:
                rooted = re.match(r'''require\s*\(\s*fromRoot\(([^)]*)\)\s*\)''', text[match.start():])
                if rooted:
                    pieces = re.findall(r'''['"]([^'"]+)['"]''', rooted[1])
                    remainder = re.sub(r'''['"][^'"]+['"]|[\s,]''', '', rooted[1])
                    if not remainder and pieces:
                        spec = '/'.join(pieces)
                        target = resolve(root, spec)
                        if target:
                            edges.append({'from': name, 'specifier': spec, 'to': target}); pending.append(target)
                        else:
                            unresolved.add((name, 'installed dependency target' if spec.startswith('node_modules/') else 'unresolved rooted import', spec))
                        continue
                line = text.count('\n', 0, match.start()) + 1
                unresolved.add((name, 'dynamic require', f'line {line}'))

    manifests = {'package.json': json.loads((root / 'package.json').read_text(encoding='utf-8-sig'))}
    for parent in ['apps', 'packages']:
        directory = root / parent
        if directory.is_dir():
            for file in directory.glob('*/package.json'):
                manifests[file.relative_to(root).as_posix()] = json.loads(file.read_text(encoding='utf-8-sig'))
    todo = [('package.json', name, 0) for name in (manifests['package.json'].get('scripts', {}) if entrypoints is None else entrypoints)]
    for name, pkg in manifests.items():
        if name != 'package.json':
            selected = (['preinstall', 'install', 'postinstall', 'prepare'] + (['prebuild', 'build', 'postbuild'] if name.startswith('apps/') else [])) if entrypoints is None else (['build'] if name in ['apps/console/package.json', 'apps/portal/package.json', 'apps/console-v2/package.json'] else [])
            todo += [(name, key, 0) for key in selected if key in pkg.get('scripts', {})]
    seen = set()
    while todo:
        manifest, script, depth = todo.pop()
        if (manifest, script, depth) in seen:
            continue
        seen.add((manifest, script, depth))
        command = manifests.get(manifest, {}).get('scripts', {}).get(script)
        if not isinstance(command, str):
            unresolved.add((manifest + '#' + script, 'missing/nonliteral script', script)); continue
        try:
            tokens = shlex.split(command.replace('&&', ' ; ').replace('||', ' ; '), posix=True)
        except ValueError:
            unresolved.add((manifest + '#' + script, 'unparsed shell quoting', script)); continue
        for index, token in enumerate(tokens):
            if token in {'node', 'sh', 'bash'}:
                end = index + 1
                while end < len(tokens) and tokens[end].startswith('-'):
                    end += 1
                if end < len(tokens) and tokens[end] not in {';', '|'}:
                    spec = tokens[end]
                    target = resolve(root / Path(manifest).parent, spec)
                    if target:
                        protected.add(target)
                    else:
                        kind = 'installed dependency target' if spec.startswith('node_modules/') else 'unresolved script target'
                        unresolved.add((manifest + '#' + script, kind, spec))
            if token == 'npm':
                tail = tokens[index + 1:]
                target_manifest = manifest
                if len(tail) >= 2 and tail[0] == '--prefix':
                    target_manifest = (Path(tail[1]) / 'package.json').as_posix(); tail = tail[2:]
                if len(tail) >= 2 and tail[0] in {'run', 'run-script'}:
                    key = tail[1]
                    if depth < 1 and target_manifest in manifests:
                        todo.append((target_manifest, key, depth + 1))
                    elif target_manifest not in manifests:
                        unresolved.add((manifest + '#' + script, 'unresolved npm prefix', target_manifest + '#' + key))
            if token in {'jest', 'playwright', 'tsc', 'next', 'cross-env', 'storybook'}:
                unresolved.add((manifest + '#' + script, 'installed tool binary', token))
    protected.update(closure)
    selective = sorted(name for name in protected if Path(name).name.lower() == 'package.json')
    protected.difference_update(selective)
    script_keys = {}
    for manifest, script, _depth in seen:
        script_keys.setdefault(manifest, set()).add(script)
    return {'backend_roots': ROOTS, 'backend_closure': sorted(closure), 'backend_edges': sorted(edges, key=lambda row: (row['from'], row['to'])),
            'script_targets': sorted(protected - closure), 'protected_paths': sorted(name.lower() for name in protected),
            'script_keys': {name.lower(): sorted(keys) for name, keys in sorted(script_keys.items())},
            'selective_manifests': selective,
            'unresolved': [{'from': a, 'kind': b, 'reference': c} for a, b, c in sorted(unresolved)]}


def update(root, output):
    data = collect(root)
    (output / 'protected-input-closure.json').write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    args = parser.parse_args()
    output = Path(__file__).resolve().parents[2]
    data = update(args.source, output)
    print(json.dumps({key: len(data[key]) for key in ['backend_closure', 'script_targets', 'protected_paths', 'unresolved']}))
