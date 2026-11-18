# Technology stack

| Area | Implementation |
| --- | --- |
| Applications | TypeScript, React, Next.js for Console and Portal, and React Native with Expo for FieldOps |
| Database | PostgreSQL migrations, row-level security and scoped SQL functions |
| Backend | Supabase Auth, Storage and Deno edge functions |
| Verification | Jest, pgTAP, Playwright and k6 |

Database-backed policy and workflow templates define behavior shared across applications. Edge functions handle the HTTP boundary and delegate durable work to database-backed workflows. Provider integrations use explicit mappings and adapter contracts.

See [architecture](architecture.md) for the relationship between applications, backend services and shared packages.
