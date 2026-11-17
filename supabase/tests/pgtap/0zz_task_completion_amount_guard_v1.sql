-- Attachment-only pgTAP amount-validator cases; transaction boundary fixtures remain required.
BEGIN;
SELECT plan(11);
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1(NULL)$$,'23514','task_completion_amount_required_nonnegative_number','SQL NULL rejected');
SELECT lives_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":0}')$$,'explicit zero accepted');
SELECT lives_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":10.123456}')$$,'precision is not rounded');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('{}')$$,'23514','task_completion_amount_required_nonnegative_number','missing rejected');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":null}')$$,'23514','task_completion_amount_required_nonnegative_number','null rejected');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":-1}')$$,'23514','task_completion_amount_required_nonnegative_number','negative rejected');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":"1"}')$$,'23514','task_completion_amount_required_nonnegative_number','numeric strings rejected');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":"NaN"}')$$,'23514','task_completion_amount_required_nonnegative_number','NaN string rejected');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":"Infinity"}')$$,'23514','task_completion_amount_required_nonnegative_number','infinity string rejected');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('[]')$$,'23514','task_completion_amount_required_nonnegative_number','array rejected');
SELECT throws_ok($$SELECT public.assert_task_completion_amount_v1('{"amount":true}')$$,'23514','task_completion_amount_required_nonnegative_number','boolean rejected');
SELECT * FROM finish();
ROLLBACK;
