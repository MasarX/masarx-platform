BEGIN;

SELECT plan(2);

SELECT has_view('public', 'label_job_barcode_summary_v', 'label_job_barcode_summary_v view exists');
SELECT has_view('public', 'label_job_barcode_blocks_v', 'label_job_barcode_blocks_v view exists');

SELECT * FROM finish();

ROLLBACK;

