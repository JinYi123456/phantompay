#!/usr/bin/env node
'use strict';

/**
 * Stage-5 quality gate CLI: runs the custom linter (hygiene + conformance)
 * and exits non-zero when error-severity findings exist. Wired as the
 * `npm run lint` script and as the repository git pre-commit hook, so
 * float-hygiene and settlement-math regressions cannot be committed.
 */

const path = require('path');
const { runLint } = require('../lib/linter');

const rootDir = path.resolve(__dirname, '..');
const report = runLint(rootDir);

console.log(
  `[lint] scanned ${report.summary.filesScanned} files with ${report.summary.hygieneRules} hygiene + ${report.summary.conformanceRules} conformance rules`
);
for (const c of report.conformance) {
  console.log(`[lint] ${c.ok ? 'pass' : 'FAIL'}  ${c.rule} - ${c.description}`);
}
for (const f of report.findings) {
  console.log(`[lint] ${f.severity.toUpperCase()} ${f.file}:${f.line || '-'} ${f.rule}: ${f.message} (hint: ${f.hint})`);
}
if (report.ok) {
  console.log(
    `[lint] OK - 0 errors, ${report.summary.warnings} warnings, ${report.summary.conformancePassed}/${report.summary.conformanceRules} conformance checks passed`
  );
  process.exit(0);
}
console.error(`[lint] FAILED - ${report.summary.errors} errors, ${report.summary.warnings} warnings`);
process.exit(1);
