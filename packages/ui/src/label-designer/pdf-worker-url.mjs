// Keep bundler-only import.meta syntax outside the CommonJS component-test boundary.
export default new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
