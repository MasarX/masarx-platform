"""Fail-closed checks for the expression subset used by these workflows; not actionlint."""
import re

TOKEN = re.compile(r"\s*(?:(?P<string>'(?:[^']|'')*')|(?P<number>\d+(?:\.\d+)?)|(?P<id>[A-Za-z_][A-Za-z0-9_]*)|(?P<op>\|\||&&|==|!=|>=|<=|[!><().,\[\]]))")
ROOTS = {'github', 'inputs', 'steps', 'needs', 'matrix'}
GITHUB = {'event', 'event_name', 'ref', 'ref_name', 'sha', 'run_id', 'run_attempt', 'repository', 'repository_owner', 'actor', 'head_ref', 'base_ref', 'workflow', 'job'}
FUNCTIONS = {'always', 'cancelled', 'success', 'failure', 'contains', 'startsWith', 'endsWith', 'format', 'join', 'toJSON', 'fromJSON', 'hashFiles'}


def validate(source, steps=(), needs=(), inputs=(), matrix=()):
    tokens = []
    offset = 0
    while offset < len(source):
        if not source[offset:].strip():
            break
        match = TOKEN.match(source, offset)
        if not match:
            raise ValueError('Invalid expression token')
        tokens.append((match.lastgroup, match.group(match.lastgroup)))
        offset = match.end()
    position = 0

    def peek(value=None):
        return position < len(tokens) and (value is None or tokens[position][1] == value)

    def take(value=None):
        nonlocal position
        if not peek(value):
            raise ValueError('Missing expression operand/delimiter')
        item = tokens[position]
        position += 1
        return item

    def atom():
        if peek('!'):
            take(); atom(); return
        if peek('('):
            take(); expression(); take(')'); return
        kind, value = take()
        if kind in {'number', 'string'} or value in {'true', 'false', 'null'}:
            return
        if kind != 'id':
            raise ValueError('Invalid expression operand')
        if peek('('):
            if value not in FUNCTIONS:
                raise ValueError('Unknown expression function')
            take()
            if not peek(')'):
                expression()
                while peek(','):
                    take(); expression()
            take(')'); return
        if value not in ROOTS:
            raise ValueError('Unknown expression context')
        parts = []
        while peek('.') or peek('['):
            if peek('.'):
                take(); item = take()
                if item[0] != 'id':
                    raise ValueError('Invalid property name')
                parts.append(item[1])
            else:
                take(); item = take()
                if item[0] not in {'string', 'number'}:
                    raise ValueError('Dynamic indexing unsupported by static substitute')
                parts.append(item[1].strip("'")); take(']')
        known = {'github': GITHUB, 'steps': set(steps), 'needs': set(needs), 'inputs': set(inputs), 'matrix': set(matrix)}
        if parts and parts[0] not in known[value]:
            raise ValueError('Unknown context property/step/job/input/matrix key')

    def comparison():
        atom()
        while peek() and tokens[position][1] in {'==', '!=', '>', '<', '>=', '<='}:
            take(); atom()

    def conjunction():
        comparison()
        while peek('&&'):
            take(); comparison()

    def expression():
        conjunction()
        while peek('||'):
            take(); conjunction()

    expression()
    if position != len(tokens):
        raise ValueError('Trailing expression syntax')


def workflow(document):
    inputs = (document.get('on', {}).get('workflow_dispatch') or {}).get('inputs', {})

    def walk(value, steps=(), needs=(), matrix=(), key=''):
        if isinstance(value, str):
            matches = list(re.finditer(r'\$\{\{(.*?)\}\}', value, re.S))
            if value.count('${{') != len(matches):
                raise ValueError('Unclosed workflow expression')
            if key == 'run' and matches:
                raise ValueError('Expressions in shell commands are forbidden')
            for match in matches:
                validate(match.group(1).strip(), steps, needs, inputs, matrix)
            if key == 'if' and not matches:
                validate(value, steps, needs, inputs, matrix)
        elif isinstance(value, dict):
            for name, item in value.items():
                walk(item, steps, needs, matrix, name)
        elif isinstance(value, list):
            for item in value:
                walk(item, steps, needs, matrix, key)

    walk({key: value for key, value in document.items() if key != 'jobs'})
    for job in document['jobs'].values():
        steps = {step['id'] for step in job.get('steps', []) if 'id' in step}
        needs = job.get('needs', [])
        matrix = job.get('strategy', {}).get('matrix', {})
        walk(job, steps, needs, matrix)
