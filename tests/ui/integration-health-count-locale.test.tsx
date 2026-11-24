/**
 * The integration health call count follows the configured Console locale (#361),
 * not the browser's, through the shared resource formatter.
 */
const COUNT = 1234567;

function renderCountCell(locale: string): string {
  const previous = process.env.NEXT_PUBLIC_LOCALE;
  process.env.NEXT_PUBLIC_LOCALE = locale;
  try {
    let text = "";
    jest.isolateModules(() => {
      // Load React Testing Library and the component in one registry so they share React.
      const { render } = require("@testing-library/react");
      const { IntegrationHealth } = require("../../packages/ui/src/integrations/integration-health");
      const { container } = render(
        <IntegrationHealth
          integrations={[{ id: "int-1", name: "Synthetic Carrier", type: "api", status: "healthy", totalCalls: COUNT }]}
        />,
      );
      text = container.querySelectorAll("tbody td")[4]?.textContent ?? "";
    });
    return text;
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = previous;
  }
}

test.each(["en", "ar", "ar-EG"])("formats the call count for the %s Console locale", (locale) => {
  expect(renderCountCell(locale)).toBe(new Intl.NumberFormat(locale).format(COUNT));
});

test("an Arabic-digit Console locale does not fall back to the runtime default", () => {
  // ar-EG uses Arabic digits; the old bare toLocaleString() gave the runtime's own digits.
  expect(renderCountCell("ar-EG")).not.toBe(COUNT.toLocaleString());
});
