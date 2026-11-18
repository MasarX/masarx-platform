## Test coverage best practices

- **Write Minimal Tests During Development**: Do NOT write tests for every change or intermediate step. Focus on completing the feature implementation first, then add strategic tests only at logical completion points
- **Test Only Core User Flows**: Write tests exclusively for critical paths and primary user workflows. Skip writing tests for non-critical utilities and secondary workflows until if/when you're instructed to do so.
- **Defer Edge Case Testing**: Do NOT test edge cases, error states, or validation logic unless they are business-critical. These can be addressed in dedicated testing phases, not during feature development.
- **Test Behavior, Not Implementation**: Focus tests on what the code does, not how it does it, to reduce brittleness
- **Clear Test Names**: Use descriptive names that explain what's being tested and the expected outcome
- **Mock External Dependencies**: Isolate units by mocking databases, APIs, file systems, and other external services
- **Readiness Exception**: For Landing + Console V2 production-readiness, mocks are unit-test tools only. Completion requires backend-backed real API/RPC/data proof plus Browser/Chrome clicked-navigation evidence; Playwright, pgTAP, screenshots, seed/demo data, in-memory adapters, and toast-only successes cannot close a readiness area.
- **Fast Execution**: Keep unit tests fast (milliseconds) so developers run them frequently during development
