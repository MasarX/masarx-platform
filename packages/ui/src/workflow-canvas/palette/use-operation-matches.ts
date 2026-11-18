"use client";

import { useState, useEffect } from "react";
import { createUiClient } from "@masarx/api";
import type { OperationMatch } from "./group-operation-matches";
import { resolveTrustedOperationDocUrl } from "../../url-guard";

/* ---------------------------------------------------------------------------
 * State shape.
 * -------------------------------------------------------------------------*/

export type OperationMatchesState = {
  matches: OperationMatch[];
  loading: boolean;
  error: string | null;
};

/* ---------------------------------------------------------------------------
 * Helpers.
 * -------------------------------------------------------------------------*/

function normalizeUiText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizeDocUrl(value: unknown) {
  if (typeof value !== "string") return null;
  return resolveTrustedOperationDocUrl(value);
}

function formatOperationMatchError(error: unknown) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error.trim() || "Unknown error";
  if (typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/* ---------------------------------------------------------------------------
 * Hook: fetches operation_handlers and returns matches filtered by query.
 * Debounces by 250ms when a query is present.
 *
 * This is a direct extraction of `useOperationMatches` from the monolith
 * (~lines 468-557 of workflow-template-steps-builder.tsx).
 * -------------------------------------------------------------------------*/

export function useOperationMatches(
  enabled: boolean,
  query: string
): OperationMatchesState {
  const [state, setState] = useState<OperationMatchesState>(() => ({
    matches: [],
    loading: false,
    error: null,
  }));

  useEffect(() => {
    if (!enabled) {
      setState({ matches: [], loading: false, error: null });
      return undefined;
    }

    const trimmed = query.trim();
    const ui = createUiClient();
    let cancelled = false;

    const handle = window.setTimeout(
      () => {
        setState((current) => ({
          matches: current.matches,
          loading: true,
          error: null,
        }));
        void (async () => {
          try {
            const response = await ui.listResource(
              "operation_handlers",
              trimmed ? { handler_key: trimmed, is_active: true } : { is_active: true },
              25,
              0,
              { key: "handler_key", direction: "asc" }
            );
            if (cancelled) return;
            const handlers = Array.isArray(response.items)
              ? response.items
                  .map((item) => {
                    const handlerKey = String(item.handler_key ?? "").trim();
                    if (!handlerKey) return null;
                    return {
                      handlerKey,
                      notes: normalizeUiText(item.notes),
                      docUrl: sanitizeDocUrl(item.doc_url),
                      handlerSchema: normalizeUiText(item.handler_schema),
                      handlerName: normalizeUiText(item.handler_name),
                      handlerVersion: normalizeUiText(item.handler_version),
                      uiLabel: normalizeUiText(item.ui_label),
                      uiCategory: normalizeUiText(item.ui_category),
                      uiDescription: normalizeUiText(item.ui_description),
                      configSchemaCategory: normalizeUiText(item.config_schema_category),
                    } satisfies OperationMatch;
                  })
                  .filter((value): value is OperationMatch => value !== null)
              : [];
            const seen = new Set<string>();
            const unique = handlers
              .filter((handler) => {
                if (seen.has(handler.handlerKey)) return false;
                seen.add(handler.handlerKey);
                return true;
              })
              .slice(0, 25);
            if (!cancelled) {
              setState({ matches: unique, loading: false, error: null });
            }
          } catch (error) {
            if (!cancelled) {
              setState({
                matches: [],
                loading: false,
                error: formatOperationMatchError(error),
              });
            }
          }
        })();
      },
      trimmed ? 250 : 0
    );

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [enabled, query]);

  return state;
}
