#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');

const outputPath = path.join(__dirname, 'public', 'tailwind.css');

// Убедиться что public папка существует
const publicDir = path.dirname(outputPath);
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

console.log('Загружаю Tailwind CSS...');

// Функция для загрузки с редиректом
function downloadFile(urlString, callback) {
    https.get(urlString, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            // Если редирект относительный, добавляем базовый URL
            const fullUrl = redirectUrl.startsWith('http') 
                ? redirectUrl 
                : 'https://cdn.tailwindcss.com' + redirectUrl;
            return downloadFile(fullUrl, callback);
        }
        
        if (response.statusCode !== 200) {
            callback(new Error(`HTTP ${response.statusCode}`));
            return;
        }

        let data = '';
        response.on('data', chunk => {
            data += chunk;
        });

        response.on('end', () => {
            callback(null, data);
        });
    }).on('error', callback);
}

// URL к Tailwind CSS CDN
const tailwindCdnUrl = 'https://cdn.tailwindcss.com';

downloadFile(tailwindCdnUrl, (err, data) => {
    if (err) {
        console.error('Ошибка при загрузке CSS:', err);
        process.exit(1);
    }

    fs.writeFileSync(outputPath, data);
    console.log(`✓ CSS скомпилирован в ${outputPath}`);
    console.log(`Размер: ${(fs.statSync(outputPath).size / 1024).toFixed(2)} KB`);
});
