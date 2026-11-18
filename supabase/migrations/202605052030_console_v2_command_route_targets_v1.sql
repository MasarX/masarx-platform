-- Console V2 command palette route targets.
-- Keeps command discovery row-driven and prevents broad section fallbacks from
-- opening the wrong operator workbench.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605052030_console_v2_command_route_targets_v1'));

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB;
  v_updated JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);

  WITH command_defaults(key, path, label, section, execution, target, capability) AS (
    VALUES
      ('shipments.create', '/operate/shipments', 'Create shipment', 'Shipments', 'workflow', NULL, 'shipments.write'),
      ('shipments.amend', '/operate/shipments', 'Amend shipment', 'Shipments', 'rpc', 'shipment_amend_cancel_v1', 'shipments.write'),
      ('shipments.cancel', '/operate/shipments', 'Cancel shipment', 'Shipments', 'rpc', 'shipment_amend_cancel_v1', 'shipments.write'),
      ('shipments.resort', '/operate/shipments', 'Resort shipment', 'Shipments', 'rpc', 'ui_execute_shipment_resort_v1', 'shipments.write'),
      ('shipments.batch_operation', '/operate/shipments', 'Bulk amend / cancel', 'Shipments', 'rpc', 'ui_execute_shipment_batch_operation_v1', 'shipments.write'),
      ('shipments.return_to_branch', '/operate/shipments', 'Return to branch', 'Shipments', 'rpc', 'record_scan_event_v1', 'shipments.write'),
      ('route_plans.solve_sequence', '/operate/route-plans', 'Solve plan sequence', 'Route plans', 'rpc', 'ui_solve_route_plan_v1', 'route_plans.write'),
      ('route_plans.publish', '/operate/route-plans', 'Publish plan', 'Route plans', 'rpc', 'ui_publish_route_plan_v1', 'route_plans.write'),
      ('route_plans.rebalance', '/operate/route-plans', 'Rebalance plan', 'Route plans', 'rpc', 'ui_rebalance_route_plan_v1', 'route_plans.write'),
      ('route_runs.assign', '/operate/dispatch', 'Assign run', 'Routes', 'rpc', 'ui_execute_route_run_assign_v1', 'routes.write'),
      ('route_runs.confirm_departure', '/operate/dispatch', 'Confirm departure', 'Routes', 'rpc', 'ui_confirm_route_run_departure_v1', 'routes.write'),
      ('route_stops.reassign', '/operate/dispatch', 'Reassign stops', 'Routes', 'rpc', 'ui_execute_route_stop_reassign_v1', 'routes.write'),
      ('pickups.create_request', '/operate/pickups', 'Create pickup request', 'Pickups', 'rpc', 'create_pickup_request_v1', 'fleet.write'),
      ('pickups.create_wave', '/operate/pickups', 'Create pickup wave', 'Pickups', 'rpc', 'create_pickup_wave_v1', 'fleet.write'),
      ('pickups.assign_wave', '/operate/pickups', 'Assign pickup wave', 'Pickups', 'rpc', 'assign_pickup_wave_v1', 'fleet.write'),
      ('exceptions.resolve', '/operate/exceptions', 'Resolve exception (NDR)', 'Exceptions', 'rpc', 'ui_execute_dispatch_exception_resolution_v1', 'tasks.write'),
      ('labels.reprint', '/platform/labels', 'Reprint label', 'Labels', 'rpc', 'request_label_reprint', 'labels.write'),
      ('warehouse.transfer_execute', '/platform/warehouse', 'Execute warehouse transfer', 'Warehouse', 'rpc', 'warehouse_transfer_execute_v1', 'warehouse.write'),
      ('warehouse_transfers.dispatch', '/platform/warehouse', 'Dispatch transfer', 'Warehouse', 'rpc', 'ui_execute_warehouse_transfer_dispatch_v1', 'warehouse.write'),
      ('warehouse_transfers.scan_departure', '/platform/warehouse', 'Scan departure', 'Warehouse', 'rpc', 'ui_execute_warehouse_transfer_checkpoint_v1', 'warehouse.write'),
      ('warehouse_transfers.scan_arrival', '/platform/warehouse', 'Scan arrival', 'Warehouse', 'rpc', 'ui_execute_warehouse_transfer_checkpoint_v1', 'warehouse.write'),
      ('warehouse_transfers.reconcile_destination', '/platform/warehouse', 'Reconcile transfer', 'Warehouse', 'rpc', 'ui_execute_warehouse_transfer_reconcile_v1', 'warehouse.write'),
      ('settings.request_change', '/platform/config', 'Request settings change', 'Platform', 'rpc', 'request_settings_change_v1', 'settings.write'),
      ('tasks.transition', '/workflows/review-queue', 'Transition task', 'Tasks', 'rpc', 'transition_task_v1', 'tasks.write'),
      ('user_devices.revoke', '/platform/mobile-policy', 'Revoke device', 'Mobile', 'rpc', 'ui_execute_user_device_revoke_v1', 'user_devices.write'),
      ('webhooks.rotate_token', '/integrations/sources', 'Rotate webhook token', 'Integrations', 'rpc', 'ui_rotate_webhook_source_token_v1', 'webhooks.write'),
      ('webhooks.toggle_source', '/integrations/sources', 'Toggle webhook source', 'Integrations', 'rpc', 'ui_upsert_webhook_source_v1', 'webhooks.write'),
      ('webhooks.upsert_source', '/integrations/sources', 'Create or update webhook source', 'Integrations', 'rpc', 'ui_upsert_webhook_source_v1', 'webhooks.write'),
      ('webhooks.toggle_rule', '/integrations/rules', 'Toggle webhook rule', 'Integrations', 'rpc', 'ui_upsert_webhook_rule_v1', 'webhooks.write'),
      ('webhooks.upsert_rule', '/integrations/rules', 'Create or update webhook rule', 'Integrations', 'rpc', 'ui_upsert_webhook_rule_v1', 'webhooks.write'),
      ('webhooks.delete_rule', '/integrations/rules', 'Delete webhook rule', 'Integrations', 'rpc', 'ui_delete_webhook_rule_v1', 'webhooks.write'),
      ('webhooks.reorder_rule', '/integrations/rules', 'Reorder webhook rule priority', 'Integrations', 'rpc', 'ui_reorder_webhook_rule_v1', 'webhooks.write'),
      ('mappings.upsert', '/integrations/mapping', 'Save mapping', 'Integrations', 'rpc', 'ui_upsert_mapping_artifact_v1', 'mappings.write'),
      ('mappings.promote_version', '/integrations/mapping', 'Promote mapping version', 'Integrations', 'rpc', 'mapping_config_promote_v1', 'mappings.write'),
      ('mappings.disable', '/integrations/mapping', 'Disable mapping', 'Integrations', 'rpc', 'ui_upsert_mapping_artifact_v1', 'mappings.write'),
      ('integrations.create_credential', '/integrations/credentials', 'Create provider credential', 'Integrations', 'rpc', 'ui_upsert_provider_auth_config_v1', 'integrations.write'),
      ('integrations.update_credential', '/integrations/credentials', 'Update provider credential', 'Integrations', 'rpc', 'ui_upsert_provider_auth_config_v1', 'integrations.write'),
      ('integrations.rotate_credential', '/integrations/credentials', 'Rotate provider credential', 'Integrations', 'rpc', 'integration_plugin_rotate_credentials_v1', 'integrations.write'),
      ('integrations.revoke_credential', '/integrations/credentials', 'Revoke provider credential', 'Integrations', 'rpc', 'ui_revoke_provider_auth_config_v1', 'integrations.write'),
      ('integrations.install_plugin', '/integrations/catalog', 'Install integration plugin', 'Integrations', 'rpc', 'integration_plugin_generate_draft_v1', 'integrations.write'),
      ('integrations.create_plugin', '/integrations/plugin-studio', 'Create integration plugin', 'Integrations', 'rpc', 'integration_plugin_generate_draft_v1', 'integrations.write'),
      ('integrations.uninstall_plugin', '/integrations/catalog', 'Uninstall integration plugin', 'Integrations', 'rpc', 'integration_plugin_rollback_v1', 'integrations.write'),
      ('integrations.retry_inbox', '/integrations/intake', 'Retry inbox event', 'Integrations', 'rpc', 'webhook_inbox_replay_v1', 'webhooks.write'),
      ('integrations.replay_inbox', '/integrations/intake', 'Replay inbox event', 'Integrations', 'rpc', 'webhook_inbox_replay_v1', 'webhooks.write'),
      ('integrations.force_inbox_status', '/integrations/intake', 'Force inbox status', 'Integrations', 'rpc', 'webhook_inbox_force_status_v1', 'webhooks.write'),
      ('workflow_templates.create', '/workflows/templates', 'New workflow template', 'Workflows', 'rpc', 'ui_create_workflow_template_v1', 'workflows.write'),
      ('workflow_templates.activate', '/workflows/templates', 'Activate workflow template', 'Workflows', 'rpc', 'ui_set_workflow_template_status_v1', 'workflows.write'),
      ('workflow_templates.deactivate', '/workflows/templates', 'Deactivate workflow template', 'Workflows', 'rpc', 'ui_set_workflow_template_status_v1', 'workflows.write'),
      ('workflow_runs.replay', '/workflows/runs', 'Replay workflow run', 'Workflows', 'rpc', 'progress_workflow_run', 'workflows.write'),
      ('workflow_runs.cancel', '/workflows/runs', 'Cancel workflow run', 'Workflows', 'rpc', 'close_workflow_run', 'workflows.write'),
      ('workflow_bindings.register', '/workflows/bindings', 'Register workflow binding', 'Workflows', 'rpc', 'register_workflow_binding_v1', 'workflows.write'),
      ('workflow_bindings.simulate', '/workflows/bindings', 'Simulate binding dispatch', 'Workflows', 'rpc', 'simulate_binding_dispatch_v1', 'workflows.write'),
      ('workflow_tasks.bulk_transition', '/workflows/review-queue', 'Bulk transition tasks', 'Workflows', 'rpc', 'bulk_transition_tasks_v1', 'tasks.write'),
      ('drivers.create', '/operate/fleet/drivers', 'Add new driver', 'Fleet', 'rpc', 'runCommand', 'fleet.write'),
      ('drivers.suspend', '/operate/fleet/drivers', 'Suspend driver(s)', 'Fleet', 'rpc', 'runCommand', 'fleet.write'),
      ('drivers.reinstate', '/operate/fleet/drivers', 'Reinstate driver', 'Fleet', 'rpc', 'runCommand', 'fleet.write'),
      ('drivers.upload_document', '/operate/fleet/drivers', 'Upload driver document', 'Fleet', 'rpc', 'runCommand', 'fleet.write'),
      ('drivers.approve_document', '/operate/fleet/drivers', 'Approve driver document', 'Fleet', 'rpc', 'runCommand', 'fleet.write'),
      ('drivers.reject_document', '/operate/fleet/drivers', 'Reject driver document', 'Fleet', 'rpc', 'runCommand', 'fleet.write'),
      ('drivers.log_duty_change', '/operate/fleet/drivers', 'Log duty change', 'Fleet', 'rpc', 'runCommand', 'fleet.write'),
      ('invoices.create_draft', '/finance/billing', 'New invoice (draft)', 'Billing', 'rpc', 'runCommand', 'billing.write'),
      ('invoices.add_line', '/finance/billing', 'Add invoice line', 'Billing', 'rpc', 'runCommand', 'billing.write'),
      ('invoices.remove_line', '/finance/billing', 'Remove invoice line', 'Billing', 'rpc', 'runCommand', 'billing.write'),
      ('invoices.send', '/finance/billing', 'Send invoice', 'Billing', 'rpc', 'runCommand', 'invoices.send'),
      ('invoices.mark_paid', '/finance/billing', 'Mark invoice paid', 'Billing', 'rpc', 'runCommand', 'billing.write'),
      ('invoices.record_refund', '/finance/billing', 'Record refund', 'Billing', 'rpc', 'runCommand', 'invoices.refund'),
      ('invoices.void', '/finance/billing', 'Void invoice', 'Billing', 'rpc', 'runCommand', 'invoices.refund'),
      ('invoices.reissue', '/finance/billing', 'Re-issue invoice', 'Billing', 'rpc', 'runCommand', 'invoices.send'),
      ('service_offerings.create', '/catalog/service-offerings', 'New offering', 'Catalog', 'rpc', 'runCommand', 'service_offerings.write'),
      ('service_offerings.edit_price', '/catalog/service-offerings', 'Edit offering price', 'Catalog', 'rpc', 'runCommand', 'service_offerings.write'),
      ('service_offerings.toggle_availability', '/catalog/service-offerings', 'Toggle offering availability', 'Catalog', 'rpc', 'runCommand', 'service_offerings.write'),
      ('service_offerings.archive', '/catalog/service-offerings', 'Archive offering', 'Catalog', 'rpc', 'runCommand', 'service_offerings.write'),
      ('marketplace.award_offer', '/network/marketplace', 'Award offer', 'Marketplace', 'rpc', 'runCommand', 'marketplace.write'),
      ('marketplace.cancel_award', '/network/marketplace', 'Cancel award', 'Marketplace', 'rpc', 'runCommand', 'marketplace.write'),
      ('marketplace.activate_contract', '/network/marketplace', 'Activate contract', 'Marketplace', 'rpc', 'runCommand', 'marketplace.write'),
      ('marketplace.renegotiate_contract', '/network/marketplace', 'Renegotiate contract', 'Marketplace', 'rpc', 'runCommand', 'marketplace.write'),
      ('marketplace.terminate_contract', '/network/marketplace', 'Terminate contract', 'Marketplace', 'rpc', 'runCommand', 'marketplace.write'),
      ('marketplace.create_request', '/network/marketplace', 'New marketplace request', 'Marketplace', 'rpc', 'runCommand', 'marketplace.write'),
      ('marketplace.refresh_reputation', '/network/marketplace', 'Refresh reputation snapshots', 'Marketplace', 'rpc', 'runCommand', 'marketplace.write')
  ),
  command_items AS (
    SELECT item, ordinality, command_defaults.path
      FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS e(item, ordinality)
      LEFT JOIN command_defaults ON command_defaults.key = item->>'key'
  ),
  patched_commands AS (
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN path IS NULL THEN item
          ELSE jsonb_set(
            item,
            '{route_targets}',
            jsonb_set(
              COALESCE(item->'route_targets', '{}'::jsonb),
              '{console}',
              jsonb_build_object('path', path),
              true
            ),
            true
          )
        END
        ORDER BY ordinality
      ),
      '[]'::jsonb
    ) AS items
    FROM command_items
  ),
  missing_commands AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'key', command_defaults.key,
            'label', command_defaults.label,
            'section', command_defaults.section,
            'execution', command_defaults.execution,
            'target', command_defaults.target,
            'capability', command_defaults.capability,
            'route_targets', jsonb_build_object(
              'console', jsonb_build_object('path', command_defaults.path)
            )
          )
        )
        ORDER BY command_defaults.key
      ),
      '[]'::jsonb
    ) AS items
    FROM command_defaults
    WHERE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_commands) AS existing(item)
       WHERE existing.item->>'key' = command_defaults.key
    )
  )
  SELECT patched_commands.items || missing_commands.items
    INTO v_updated
    FROM patched_commands
    CROSS JOIN missing_commands;

  v_current := jsonb_set(v_current, '{commands}', COALESCE(v_updated, v_commands), true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Seed Console V2 command palette route targets',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

DO $$
DECLARE
  v_global_commands JSONB;
  v_scope RECORD;
  v_commands JSONB;
  v_updated JSONB;
BEGIN
  SELECT sv.value->'commands'
    INTO v_global_commands
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_global_commands IS NULL THEN
    RAISE EXCEPTION 'patched global ui_command_registry commands missing';
  END IF;

  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
  LOOP
    v_commands := COALESCE(v_scope.value->'commands', '[]'::jsonb);

    WITH scoped_items AS (
      SELECT item, ordinality
        FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS e(item, ordinality)
    ),
    global_items AS (
      SELECT item, ordinality
        FROM jsonb_array_elements(v_global_commands) WITH ORDINALITY AS e(item, ordinality)
       WHERE item->>'key' IN (
         'shipments.create',
         'shipments.amend',
         'shipments.cancel',
         'shipments.resort',
         'shipments.batch_operation',
         'shipments.return_to_branch',
         'route_plans.solve_sequence',
         'route_plans.publish',
         'route_plans.rebalance',
         'route_runs.assign',
         'route_runs.confirm_departure',
         'route_stops.reassign',
         'pickups.create_request',
         'pickups.create_wave',
         'pickups.assign_wave',
         'exceptions.resolve',
         'labels.reprint',
         'warehouse.transfer_execute',
         'warehouse_transfers.dispatch',
         'warehouse_transfers.scan_departure',
         'warehouse_transfers.scan_arrival',
         'warehouse_transfers.reconcile_destination',
         'settings.request_change',
         'tasks.transition',
         'user_devices.revoke',
         'webhooks.rotate_token',
         'webhooks.toggle_source',
         'webhooks.upsert_source',
         'webhooks.toggle_rule',
         'webhooks.upsert_rule',
         'webhooks.delete_rule',
         'webhooks.reorder_rule',
         'mappings.upsert',
         'mappings.promote_version',
         'mappings.disable',
         'integrations.create_credential',
         'integrations.update_credential',
         'integrations.rotate_credential',
         'integrations.revoke_credential',
         'integrations.install_plugin',
         'integrations.create_plugin',
         'integrations.uninstall_plugin',
         'integrations.retry_inbox',
         'integrations.replay_inbox',
         'integrations.force_inbox_status',
         'workflow_templates.create',
         'workflow_templates.activate',
         'workflow_templates.deactivate',
         'workflow_runs.replay',
         'workflow_runs.cancel',
         'workflow_bindings.register',
         'workflow_bindings.simulate',
         'workflow_tasks.bulk_transition',
         'drivers.create',
         'drivers.suspend',
         'drivers.reinstate',
         'drivers.upload_document',
         'drivers.approve_document',
         'drivers.reject_document',
         'drivers.log_duty_change',
         'invoices.create_draft',
         'invoices.add_line',
         'invoices.remove_line',
         'invoices.send',
         'invoices.mark_paid',
         'invoices.record_refund',
         'invoices.void',
         'invoices.reissue',
         'service_offerings.create',
         'service_offerings.edit_price',
         'service_offerings.toggle_availability',
         'service_offerings.archive',
         'marketplace.award_offer',
         'marketplace.cancel_award',
         'marketplace.activate_contract',
         'marketplace.renegotiate_contract',
         'marketplace.terminate_contract',
         'marketplace.create_request',
         'marketplace.refresh_reputation'
       )
    ),
    patched_existing AS (
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN global_items.item IS NULL THEN scoped_items.item
            ELSE jsonb_set(
              scoped_items.item,
              '{route_targets}',
              jsonb_set(
                COALESCE(scoped_items.item->'route_targets', '{}'::jsonb),
                '{console}',
                global_items.item#>'{route_targets,console}',
                true
              ),
              true
            )
          END
          ORDER BY scoped_items.ordinality
        ),
        '[]'::jsonb
      ) AS items
      FROM scoped_items
      LEFT JOIN global_items ON global_items.item->>'key' = scoped_items.item->>'key'
    ),
    missing AS (
      SELECT COALESCE(
        jsonb_agg(global_items.item ORDER BY global_items.ordinality),
        '[]'::jsonb
      ) AS items
      FROM global_items
      WHERE NOT EXISTS (
        SELECT 1
          FROM scoped_items
         WHERE scoped_items.item->>'key' = global_items.item->>'key'
      )
    )
    SELECT patched_existing.items || missing.items
      INTO v_updated
      FROM patched_existing
      CROSS JOIN missing;

    v_scope.value := jsonb_set(v_scope.value, '{commands}', COALESCE(v_updated, v_commands), true);

    UPDATE public.settings_versions sv
       SET value = v_scope.value,
           version = v_scope.version + 1,
           change_reason = 'Seed Console V2 scoped command palette route targets',
           approved_at = now(),
           effective_from = now()
     WHERE sv.id = v_scope.settings_version_id
       AND v_scope.value IS DISTINCT FROM sv.value;

    UPDATE public.settings s
       SET cached_value = v_scope.value,
           last_updated = now()
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = v_scope.scope_type
       AND s.scope_id IS NOT DISTINCT FROM v_scope.scope_id
       AND s.settings_version_id = v_scope.settings_version_id
       AND v_scope.value IS DISTINCT FROM s.cached_value;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605052030_console_v2_command_route_targets_v1'));

COMMIT;
