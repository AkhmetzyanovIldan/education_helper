#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-i', './src/input.css', '-o', './public/tailwind.css', '--minify'], { cwd: __dirname, stdio: 'inherit' });
process.exit(result.status ?? 1);
