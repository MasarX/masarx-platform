import { withPortalConfig } from "../app-context";

export default withPortalConfig(({ t }) => (
    <div className="space-y-4" data-testid="portal-help-ready">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-ui-ink">{t("help.title")}</h1>
        <p className="text-sm text-ui-muted" data-testid="portal-help-intro">
          {t("help.intro")}
        </p>
      </header>
      <div
        className="rounded-xl border border-ui-border bg-ui-surface/70 p-4 text-sm text-ui-muted"
        data-testid="portal-help-contact"
      >
        {t("help.contact")}
      </div>
    </div>
), { authMode: "optional" });
