'use strict';

const { readFileSync } = require('node:fs');
const ts = require('typescript');

function checkBundle(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const checkSpecifier = specifier => {
    if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('node:')) {
      const { line } = source.getLineAndCharacterOfPosition(specifier?.getStart(source) ?? 0);
      throw new Error(`Unbundled Edge import in ${file}:${line + 1}`);
    }
  };

  // shortcut: require()/createRequire specifiers are not checked; add them if a bundle starts using them.
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      checkSpecifier(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      checkSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

try {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('Frozen Edge bundle paths are required');
  for (const file of files) checkBundle(file);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
