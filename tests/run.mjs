import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const files = (await readdir(here))
  .filter(name => name.endsWith('.test.mjs'))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

for (const file of files) {
  const moduleUrl = pathToFileURL(join(here, file)).href;
  const module = await import(moduleUrl);
  const tests = Array.isArray(module.tests) ? module.tests : [];
  for (const test of tests) {
    try {
      await test.run();
      passed += 1;
      console.log(`  ok  ${file} :: ${test.name}`);
    } catch (error) {
      failed += 1;
      failures.push({ file, name: test.name, error });
      console.log(`  FAIL ${file} :: ${test.name}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) {
    console.log(`\n${failure.file} :: ${failure.name}`);
    console.log(failure.error?.stack ?? failure.error);
  }
  process.exit(1);
}
