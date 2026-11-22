import collections
import functools
import json
import re
import sys
from pathlib import Path

MIGRATIONS = "supabase/migrations/"
TESTS = "supabase/tests/pgtap/"
IDENT = r'(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)'
QUALIFIED = re.compile(rf'({IDENT})\s*\.\s*({IDENT})')
NAME = rf'{IDENT}(?:\s*\.\s*{IDENT})?'
CALL = re.compile(rf'({NAME})\s*\(')
DDL = re.compile(
    rf'\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?|ALTER\s+|DROP\s+)'
    rf'(?:MATERIALIZED\s+VIEW|TABLE|VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SEQUENCE|INDEX)\s+'
    rf'(?:IF\s+(?:NOT\s+)?EXISTS\s+)?({NAME})|'
    rf'\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|ON)\s+({NAME})', re.I
)
SERVICES = {
    "auth": r'\bauth\s*\.',
    "storage": r'\bstorage\s*\.',
    "realtime": r'\brealtime\s*\.',
    "gateway_api": r'/rest/v1|/auth/v1|/storage/v1|\bkong\b|\bsupabase_url\b',
    "edge": r'/functions/v1|\bedge[_ -]runtime\b',
    "outbound_http": r'\bnet\s*\.\s*http_|\bhttp_(?:get|post|put|delete)\s*\(',
}
GLOBAL = re.compile(
    r'^supabase/tests/pgtap/(?:045a_|00_enable_)|'
    r'^supabase/(?:config\.toml|seed(?:/|\.sql$))|'
    r'^config/ci/|^scripts/(?:ci-hosted|ops/ci)/|^scripts/tests/run-pgtap|'
    r'^\.github/workflows/|'
    r'^supabase/migrations/[^/]*(?:lookup|contract|settings.*registry|registry.*settings|'
    r'managed.grants|definer.*allowlist|extension)[^/]*\.sql$', re.I
)


def normalized(token):
    token = token.strip()
    return token[1:-1].replace('""', '"') if token.startswith('"') else token.lower()


def without_comments(text):
    # Keep quoted strings and dollar bodies, where dynamic SQL and TAP object arguments live.
    return re.sub(r'/\*.*?\*/|--[^\n]*', ' ', text, flags=re.S)


def build_map(catalog):
    names = collections.defaultdict(set)
    routines = collections.defaultdict(set)
    for key, schema, name, body in catalog["objects"]:
        for parts in [(schema, name), (name,)]:
            names[parts].add(key)
            if key.startswith("pg_proc:"):
                routines[parts].add(key)

    def resolve(token, index):
        pair = QUALIFIED.fullmatch(token)
        return index[tuple(map(normalized, pair.groups())) if pair else (normalized(token),)]

    edges = collections.defaultdict(set)
    for source, target in catalog["edges"]:
        edges[source].add(target)
    body_edges = set()
    for key, _, _, body in catalog["objects"]:
        for call in CALL.findall(without_comments(body or "")):
            for callee in resolve(call, routines) - {key}:
                edges[callee].add(key)
                body_edges.add((callee, key))

    tests, by_object, services, serial = {}, collections.defaultdict(set), {}, []
    canonical = re.compile(r"""['"]postgres['"]|\b(?:current_database\s*\(|has_database_privilege\s*\(|pg_database\b|pg_db_role_setting\b|dblink\w*\b|postgres_fdw\b|cron\s*\.|net\s*\.|pg_(?:try_)?advisory_\w+|(?:create|alter|drop)\s+(?:database|role|user|tablespace|server)\b|alter\s+system\b)""", re.I)
    for file in sorted(Path(TESTS).glob("*.sql")):
        raw = file.read_text(encoding="utf-8-sig")
        text = without_comments(raw)
        keys = set()
        for match in QUALIFIED.finditer(text):
            keys.update(resolve(match.group(), names))
        for token in re.findall(IDENT, text):
            keys.update(resolve(token, names))
        tests[file.name] = sorted(keys)
        for key in keys:
            by_object[key].add(file.name)
        services[file.name] = [service for service, pattern in SERVICES.items() if re.search(pattern, text, re.I)]
        if canonical.search(raw) or not re.search(r'\brollback\s*;\s*$', re.sub(r'^\s*--[^\n]*', '', raw, flags=re.M), re.I):
            serial.append(file.name)

    @functools.lru_cache(maxsize=None)
    def reachable_tests(root):
        seen, pending, found = {root}, [root], set()
        while pending:
            key = pending.pop()
            found.update(by_object[key])
            for dependent in edges[key] - seen:
                seen.add(dependent)
                pending.append(dependent)
        return frozenset(found)

    migrations = {}
    for file in sorted(Path(MIGRATIONS).glob("*.sql")):
        text = without_comments(file.read_text(encoding="utf-8-sig"))
        keys = set()
        for ddl, dml in DDL.findall(text):
            keys.update(resolve(ddl or dml, names))
        unknown = not keys or bool(re.search(r'\b(?:EXECUTE\s+(?:format\s*\(|quote_ident\s*\(|\w+\s*\|\|)|DROP\s+SCHEMA\b|ALTER\s+DEFAULT\s+PRIVILEGES\b)', text, re.I))
        reach = sorted(set().union(*(reachable_tests(key) for key in keys)))
        migrations[file.name] = {"objects": sorted(keys), "reachable": reach, "uncertain": unknown}
    return {"objects": {key: [schema, name] for key, schema, name, _ in catalog["objects"]},
            "catalog_edges": sorted(catalog["edges"]), "body_edges": sorted(body_edges),
            "tests": tests, "migrations": migrations, "service_signals": services, "serial": serial}


def select(mapping, paths):
    picked, reasons = set(), []
    migrations, tests = mapping["migrations"], mapping["tests"]
    for path in paths:
        name = Path(path).name
        if GLOBAL.search(path):
            reasons.append((path, "global input"))
        elif path.startswith(MIGRATIONS):
            row = migrations.get(name)
            if not row or row["uncertain"]:
                reasons.append((path, "missing or uncertain migration map"))
            else:
                picked.update(row["reachable"])
        elif path.startswith(TESTS):
            if name in tests:
                picked.add(name)
            else:
                reasons.append((path, "missing test map"))
    if reasons:
        return sorted(tests), reasons
    if picked and "00_enable_pgtap.sql" in tests:
        picked.add("00_enable_pgtap.sql")
    return sorted(picked), reasons


def main():
    operation, location, *args = sys.argv[1:]
    if operation == "map":
        catalog = json.load(sys.stdin)
        mapping = build_map(catalog)
        assert mapping["tests"] and mapping["migrations"] and mapping["objects"]
        Path(location).write_text(json.dumps(mapping, separators=(",", ":")), encoding="utf-8")
        return
    mapping = json.loads(Path(location).read_text(encoding="utf-8"))
    if operation == "proof":
        migration, test = args
        picked, reasons = select(mapping, [MIGRATIONS + migration])
        leaf, = (key for key, name in mapping["objects"].items() if name == ["public", "measure_leaf"])
        outer, = (key for key, name in mapping["objects"].items() if name == ["public", "geocoding_normalize_candidate_code"] and key.startswith("pg_proc:"))
        assert not reasons and test in picked and len(picked) < len(mapping["tests"])
        assert leaf in mapping["migrations"][migration]["objects"] and leaf not in mapping["tests"][test]
        assert outer in mapping["tests"][test] and [leaf, outer] in mapping["body_edges"]
        print(json.dumps({"migration": migration, "test": test, "direct_leaf_reference": False,
                          "edge": [leaf, outer], "selected_count": len(picked)}))
    elif operation == "sample":
        prs = json.loads(Path(args[0]).read_text(encoding="utf-8-sig"))
        output = []
        for pr in prs:
            if len(pr["paths"]) != pr["changedFiles"]:
                raise ValueError(f'incomplete file list for PR {pr["number"]}')
            paths = pr["paths"] + pr.get("previousPaths", [])
            picked, reasons = select(mapping, paths)
            output.append({"number": pr["number"], "db": any(p.startswith((MIGRATIONS, TESTS)) for p in paths),
                           "count": len(picked), "files": picked, "rerun_all": reasons})
        print(json.dumps(output, indent=2))
    else:
        raise ValueError(operation)


if __name__ == "__main__":
    main()
