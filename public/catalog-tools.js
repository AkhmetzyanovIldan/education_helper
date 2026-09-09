'use strict';
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CatalogTools = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const parts = [
        ['institution', 'Учебное заведение', 2], ['specialty', 'Специальность', 2],
        ['course', 'Курс', 1], ['semester', 'Семестр', 1],
        ['subject', 'Предмет', 2], ['work', 'Работа', 2], ['variant', 'Вариант', 2]
    ];
    const isCode = value => typeof value === 'string' && /^\d{10}_\d{2}$/.test(value);
    function buildCode(values) {
        const segments = parts.map(([key,,width]) => {
            const value = String(values[key] ?? '').trim();
            return new RegExp('^\\d{1,' + width + '}$').test(value) ? value.padStart(width, '0') : null;
        });
        return segments.includes(null) ? '' : segments.slice(0,6).join('') + '_' + segments[6];
    }
    function parseCode(code) {
        if (!isCode(code)) return null;
        const digits = code.replace('_','');
        let offset = 0;
        return Object.fromEntries(parts.map(([key,,width]) => {
            const value = digits.slice(offset,offset + width); offset += width;
            return [key,value];
        }));
    }
    function formatCode(code) {
        const values = parseCode(code);
        return values ? parts.slice(0,6).map(([key]) => values[key]).join(' ') + ' _' + values.variant : code;
    }
    function materialCode(id,item) { return item.materialCode || (isCode(id) ? id : ''); }
    function label(id,item) {
        const code = materialCode(id,item), values = parseCode(code);
        return [
            item.institution || (values ? 'УЗ ' + values.institution : ''),
            item.specialty || (values ? 'Спец. ' + values.specialty : ''),
            item.course,item.semester,item.subject,item.name,item.variant,
            'ID ' + (code || id)
        ].filter(Boolean).join(' → ');
    }
    function sameGroup(item, source, field) {
        const keys = ['institution','specialty','course','semester'];
        if (field === 'name') keys.push('subject');
        return keys.every(key => (item[key] || '') === (source[key] || '')) && item[field] === source[field];
    }
    return { parts, isCode, buildCode, parseCode, formatCode, materialCode, label, sameGroup };
});
