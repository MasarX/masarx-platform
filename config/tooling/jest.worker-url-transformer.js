exports.name = "jest-worker-url";
exports.version = 2;
exports.factory = ({ configSet }) => (context) => (source) => {
  if (!source.fileName.replace(/\\/g, "/").endsWith("/resource-import/tabular-file-parser-worker-client.ts")) {
    return source;
  }
  const ts = configSet.compilerModule;
  // CommonJS component tests need a synthetic base for the browser bundler's worker URL.
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "url"
      && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      && node.expression.name.text === "meta") {
      return context.factory.createStringLiteral("https://example.test/parser.js");
    }
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(source, visit);
};
