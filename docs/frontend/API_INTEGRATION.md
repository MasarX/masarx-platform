# API Integration

How the frontend communicates with the backend through Supabase RPC, React Query, and server actions.

## Supabase RPC Clients

Two factory functions create Supabase clients depending on the execution context:

| Factory | Context | Location |
|---|---|---|
| `createUiClient()` | Browser (client components) | `packages/api/src/supabase-ui.ts` |
| `createUiServerClient()` | Server (RSC, server actions); wrapped with React `cache()` | `packages/api/src/supabase-ui-server.ts` |

## Typed Client Wrapper

`packages/api/src/ui-client.ts` wraps the raw Supabase client with typed methods:

```ts
const ui = createUiClient();

// List with filters, sort, pagination
await ui.listResource({ resource: "tasks", filters, sort, limit, offset });

// Single record
await ui.getResource({ resource: "tasks", id });

// Mutations
await ui.updateResource({ resource: "tasks", id, patch: { title: "New" } });
await ui.reorderResource({ resource: "tasks", id, position: 3 });

// Workflows
await ui.startWorkflowRun({ templateId, input });
await ui.createWorkflowTemplate({ name, steps });

// Escape hatch for arbitrary RPCs
await ui.rpc("ui_delete_resource_v1", { p_resource: "tasks", p_id: id });
```

## Retry Logic

`createRpc(client)` in `packages/api/src/rpc.ts` wraps every RPC call with automatic retries:

- **Max retries:** 2
- **Backoff:** 150 ms -- 1200 ms with jitter
- **Retriable conditions:** `isRetriableNetworkError` (fetch failures, timeouts) and `isRetriableSupabaseError` (transient Postgres/connection errors), both defined in `packages/api/src/retry.ts`

## React Query

### Provider & Defaults

`packages/ui/src/query-provider.tsx` configures the global `QueryClient`:

| Setting | Value |
|---|---|
| `staleTime` | 30 000 ms |
| `refetchOnWindowFocus` | `false` |
| `retry` | 1 |
| `retryDelay` | Exponential backoff, capped at 3 000 ms |

### Hooks

**`useResourceQuery`** -- paginated list queries (`packages/ui/src/hooks/`):

```ts
const { data, isLoading } = useResourceQuery("tasks", {
  filters: { status: "open" },
  sort: { col: "created_at", dir: "desc" },
  limit: 25,
  offset: 0,
});
```

- Query key: `["resource", resourceKey, { filters, sort, limit, offset }]`
- `staleTime`: 30 s
- `keepPreviousData`: true (smooth pagination)
- Accepts `initialData` for SSR hydration

**`useResourceDetail`** -- single-record queries:

```ts
const { data } = useResourceDetail("tasks", taskId);
```

- Query key: `["resource-detail", resourceKey, detailId]`
- `staleTime`: 30 s

**`useResourceListInvalidate`** -- returns a function that invalidates all list queries for a resource:

```ts
const invalidateTasks = useResourceListInvalidate("tasks");
// After a mutation:
invalidateTasks(); // invalidates ["resource", "tasks"]
```

### Optimistic Updates

`useOptimisticMutation` in `packages/ui/src/optimistic.ts` implements the standard optimistic pattern:

1. **`onMutate`** -- cancels in-flight queries, snapshots current data, applies the optimistic value to the cache.
2. **`onError`** -- reverts the cache to the snapshot.
3. **`onSettled`** -- invalidates affected queries so the server state is fetched.

### Direct Mutations (No Hook)

When a dedicated hook is unnecessary, mutate directly and invalidate manually:

```ts
await ui.updateResource({ resource: "tasks", id, patch });
queryClient.invalidateQueries(["resource", "tasks"]);
```

## Server Actions

Server-side mutations use the `"use server"` directive and return a `{status, message}` object consumed by `useActionState`:

```ts
// Inside a page file, e.g. access-policy-request-page.tsx
"use server";

async function submitRequest(_prev: ActionState, formData: FormData) {
  const ui = createUiServerClient();
  const result = await ui.rpc("ui_create_access_request_v1", {
    p_policy_id: formData.get("policyId"),
  });
  if (result.error) return { status: "error", message: formatUiError(result.error) };
  return { status: "success", message: "Request submitted." };
}
```

## Error Handling

### `formatUiError(error, fallback?)`

Utility in `packages/ui/src/utils.ts` that extracts a user-facing message from various error shapes (Supabase error objects, plain strings, unknown throws). Returns `fallback` when no message can be derived.

### Special Error Detection

| Helper | Detects |
|---|---|
| `isRetriableNetworkError` | Fetch failures, DNS errors, timeouts |
| `isRetriableSupabaseError` | Transient Postgres errors |
| Capability denied detection | Permission / authorization errors |
| Statement timeout (code `57014`) | Long-running query killed by Postgres |

### Error Boundary

A class component in `packages/ui/src/error-boundary.tsx` catches render-time exceptions and calls `reportClientError()` to log them.

### Toast Notifications

```ts
const { toast } = useToast();

toast({ tone: "success", message: "Saved." });
toast({ tone: "error",   message: "Something went wrong." });
```

Tones: `neutral` | `success` | `error` | `warning` | `info`. Default auto-dismiss: 5 s.

## UI Event Reporting

`packages/ui/src/reporting.ts` exposes two functions:

| Function | Purpose |
|---|---|
| `reportUiEvent()` | Tracks user actions and feature usage |
| `reportClientError()` | Logs client-side errors (also called by the error boundary) |

Both delegate to a pluggable reporter installed via `setUiReporter(reporter)`, allowing the host app to route events to any analytics or logging backend.
