// HTTPS in deployed environments; localhost remains usable for browser tests.
if (window.isSecureContext && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("FieldOps offline shell unavailable", error);
    });
  });
}
