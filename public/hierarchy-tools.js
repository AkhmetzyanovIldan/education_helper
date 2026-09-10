'use strict';
(function(root,factory){
    if(typeof module==='object' && module.exports) module.exports=factory();
    else root.HierarchyTools=factory();
})(typeof globalThis!=='undefined' ? globalThis : this,function(){
    const levels=[
        {key:'institution',title:'Учебное заведение',plural:'Учебные заведения'},
        {key:'specialty',title:'Специальность',plural:'Специальности'},
        {key:'course',title:'Курс',plural:'Курсы'},
        {key:'semester',title:'Семестр',plural:'Семестры'},
        {key:'subject',title:'Предмет',plural:'Предметы'},
        {key:'name',title:'Работа',plural:'Работы'},
        {key:'variant',title:'Вариант',plural:'Варианты'}
    ];
    function code(path){
        const parts=path.map(node=>String(node.number).padStart(2,'0'));
        return parts.length===7 ? parts.slice(0,6).join('')+'_'+parts[6] : parts.join('');
    }
    function formattedCode(path){
        const parts=path.map(node=>String(node.number).padStart(2,'0'));
        return parts.length===7 ? parts.slice(0,6).join(' ')+' _'+parts[6] : parts.join(' ');
    }
    function label(item){return levels.map(level=>item[level.key]).filter(Boolean).join(' → ')+' · ID '+(item.materialCode || '');}
    return {levels,code,formattedCode,label};
});
