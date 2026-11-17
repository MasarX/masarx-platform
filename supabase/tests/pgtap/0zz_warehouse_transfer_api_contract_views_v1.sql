BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(42);

SELECT ok(has_schema_privilege('authenticated', 'api', 'USAGE'), 'authenticated has USAGE on api schema');
SELECT ok(has_schema_privilege('service_role', 'api', 'USAGE'), 'service_role has USAGE on api schema');
SELECT ok(has_schema_privilege('anon', 'api', 'USAGE'), 'anon retains api schema USAGE for the whitelisted public tracking facade');

SELECT has_view('api', 'handling_units', 'api.handling_units view exists');
SELECT ok(has_table_privilege('authenticated', 'api.handling_units', 'SELECT'), 'authenticated can SELECT api.handling_units');
SELECT ok(has_table_privilege('authenticated', 'api.handling_units', 'INSERT'), 'authenticated can INSERT api.handling_units');
SELECT ok(has_table_privilege('authenticated', 'api.handling_units', 'UPDATE'), 'authenticated can UPDATE api.handling_units');
SELECT ok(has_table_privilege('authenticated', 'api.handling_units', 'DELETE'), 'authenticated can DELETE api.handling_units');
SELECT ok(has_table_privilege('service_role', 'api.handling_units', 'SELECT'), 'service_role can SELECT api.handling_units');
SELECT ok(has_table_privilege('service_role', 'api.handling_units', 'INSERT'), 'service_role can INSERT api.handling_units');
SELECT ok(has_table_privilege('service_role', 'api.handling_units', 'UPDATE'), 'service_role can UPDATE api.handling_units');
SELECT ok(has_table_privilege('service_role', 'api.handling_units', 'DELETE'), 'service_role can DELETE api.handling_units');
SELECT ok(NOT has_table_privilege('anon', 'api.handling_units', 'SELECT'), 'anon cannot SELECT api.handling_units');
SELECT ok(NOT has_table_privilege('anon', 'api.handling_units', 'INSERT'), 'anon cannot INSERT api.handling_units');
SELECT ok(NOT has_table_privilege('anon', 'api.handling_units', 'UPDATE'), 'anon cannot UPDATE api.handling_units');
SELECT ok(NOT has_table_privilege('anon', 'api.handling_units', 'DELETE'), 'anon cannot DELETE api.handling_units');

SELECT has_view('api', 'warehouse_transfers', 'api.warehouse_transfers view exists');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfers', 'SELECT'), 'authenticated can SELECT api.warehouse_transfers');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfers', 'INSERT'), 'authenticated can INSERT api.warehouse_transfers');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfers', 'UPDATE'), 'authenticated can UPDATE api.warehouse_transfers');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfers', 'DELETE'), 'authenticated can DELETE api.warehouse_transfers');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfers', 'SELECT'), 'service_role can SELECT api.warehouse_transfers');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfers', 'INSERT'), 'service_role can INSERT api.warehouse_transfers');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfers', 'UPDATE'), 'service_role can UPDATE api.warehouse_transfers');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfers', 'DELETE'), 'service_role can DELETE api.warehouse_transfers');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfers', 'SELECT'), 'anon cannot SELECT api.warehouse_transfers');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfers', 'INSERT'), 'anon cannot INSERT api.warehouse_transfers');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfers', 'UPDATE'), 'anon cannot UPDATE api.warehouse_transfers');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfers', 'DELETE'), 'anon cannot DELETE api.warehouse_transfers');

SELECT has_view('api', 'warehouse_transfer_items', 'api.warehouse_transfer_items view exists');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfer_items', 'SELECT'), 'authenticated can SELECT api.warehouse_transfer_items');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfer_items', 'INSERT'), 'authenticated can INSERT api.warehouse_transfer_items');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfer_items', 'UPDATE'), 'authenticated can UPDATE api.warehouse_transfer_items');
SELECT ok(has_table_privilege('authenticated', 'api.warehouse_transfer_items', 'DELETE'), 'authenticated can DELETE api.warehouse_transfer_items');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfer_items', 'SELECT'), 'service_role can SELECT api.warehouse_transfer_items');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfer_items', 'INSERT'), 'service_role can INSERT api.warehouse_transfer_items');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfer_items', 'UPDATE'), 'service_role can UPDATE api.warehouse_transfer_items');
SELECT ok(has_table_privilege('service_role', 'api.warehouse_transfer_items', 'DELETE'), 'service_role can DELETE api.warehouse_transfer_items');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfer_items', 'SELECT'), 'anon cannot SELECT api.warehouse_transfer_items');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfer_items', 'INSERT'), 'anon cannot INSERT api.warehouse_transfer_items');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfer_items', 'UPDATE'), 'anon cannot UPDATE api.warehouse_transfer_items');
SELECT ok(NOT has_table_privilege('anon', 'api.warehouse_transfer_items', 'DELETE'), 'anon cannot DELETE api.warehouse_transfer_items');

SELECT * FROM finish();

ROLLBACK;
