#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

console.log('Компилирую Tailwind CSS...');
execSync(
    'npx tailwindcss@3 -i ./src/input.css -o ./public/tailwind.css --minify',
    { stdio: 'inherit' }
);
console.log('✓ CSS скомпилирован в public/tailwind.css');
