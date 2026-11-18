# Local development

Use the Node.js version specified in the root `.nvmrc` and install the locked npm dependencies from the root. Use a disposable database and generated test data for work that writes application state. Keep environment files and credentials out of version control.

Run the application you are changing from the repository root.

| Application | Command |
| --- | --- |
| Console V2 | `npm run dev:console:v2` |
| Console | `npm run dev:console` |
| Portal | `npm run dev:portal` |
| FieldOps | `npm run dev:fieldops` |
| Landing site | `npm run dev:landing` |

Use separate backend configuration for each isolated checkout. Verify the configured database and API target before seeding data, applying migrations, or running integration tests. The [testing guide](TESTING_GUIDE.md) identifies which suites require a backend.
