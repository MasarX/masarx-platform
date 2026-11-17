-- Test Suite: render_template token handling and structures

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT is(
    (
        SELECT render_template(
            '{"value":"{{ context.id }}"}'::jsonb,
            jsonb_build_object('context', jsonb_build_object('id', 'abc123'))
        )->>'value'
    ),
    'abc123',
    'render_template substitutes simple object tokens'
);

SELECT is(
    (
        SELECT render_template(
            '{"token":"{{  resource.tracking_number  }}"}'::jsonb,
            jsonb_build_object('resource', jsonb_build_object('tracking_number', 'TN001'))
        )->>'token'
    ),
    'TN001',
    'render_template trims whitespace around tokens'
);

SELECT is(
    (
        SELECT render_template(
            '["{{ a }}","static","{{ b }}"]'::jsonb,
            jsonb_build_object('a', 'first', 'b', 'second')
        )::text
    ),
    '["first", "static", "second"]',
    'render_template iterates arrays and applies substitutions'
);

SELECT is(
    (
        SELECT render_template(
            '{"missing":"{{ unknown.path }}"}'::jsonb,
            '{}'::jsonb
        )->>'missing'
    ),
    '',
    'render_template replaces missing tokens with empty string'
);

SELECT * FROM finish();

ROLLBACK;
