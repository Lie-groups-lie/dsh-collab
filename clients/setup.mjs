#!/usr/bin/env node
import { main } from './lib/setup.mjs';
main(import.meta.dirname).catch(error => {
  // Only argument/manifest errors reach here; never print underlying file paths.
  process.stderr.write('DSH_SETUP_FAILED: check the extracted Clients package, platform and arguments. Use node setup.mjs doctor [--live] or install codex|claude [--apply] [--cli PATH].\n');
  process.exitCode = 1;
});
