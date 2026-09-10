'use strict';
const {randomUUID}=require('node:crypto');
const {CatalogError}=require('./catalog-error');
const {levels,code}=require('../public/hierarchy-tools');
const schema=`
CREATE TABLE IF NOT EXISTS catalog_nodes (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES catalog_nodes(id),
    level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 6),
    number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 99),
    name TEXT NOT NULL,
    material_id TEXT UNIQUE,
    archived BOOLEAN NOT NULL DEFAULT false,
    version INTEGER NOT NULL DEFAULT 1,
    creation_key TEXT UNIQUE,
    CHECK ((level=0)=(parent_id IS NULL)),
    CHECK ((level=6)=(material_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_node_number ON catalog_nodes ((COALESCE(parent_id,'')),number);
CREATE INDEX IF NOT EXISTS catalog_node_parent ON catalog_nodes(parent_id);
CREATE TABLE IF NOT EXISTS catalog_structure_state (
    slot INTEGER PRIMARY KEY CHECK(slot=1),
    initialized BOOLEAN NOT NULL DEFAULT false,
    revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO catalog_structure_state(slot) VALUES(1) ON CONFLICT DO NOTHING;
`;
class Hierarchy {
    constructor(store){this.store=store;this.ready=null;}
    async ensure(base){
        if(!this.ready) this.ready=this.store.editCatalog(async client=>{
            const state=(await client.query('SELECT * FROM catalog_structure_state WHERE slot=1')).rows[0];
            if(state.initialized) return;
            const items=await this.store.catalog(base,client), nodes=[];
            const defaults=['РГУНиГ','РФ','Курс не указан','Семестр не указан','Предмет не указан','Работа без названия','Вариант без названия'];
            const institution=await this.insert(client,nodes,null,0,'РГУНиГ');nodes.push(institution);
            const specialty=await this.insert(client,nodes,institution.id,1,'РФ');nodes.push(specialty);
            for(const [materialId,item] of Object.entries(items)){
                let parent=null;const path=[];
                for(let level=0;level<levels.length;level++){
                    const name=String(item[levels[level].key] || defaults[level]).trim() || defaults[level];
                    let node=level<6 && nodes.find(n=>n.parent_id===parent && n.name===name);
                    if(!node){
                        node=await this.insert(client,nodes,parent,level,name,level===6 ? materialId : null);
                        nodes.push(node);
                    }
                    path.push(node);parent=node.id;
                }
                await this.writeItem(client,materialId,{...item,...this.metadata(path)});
            }
            await client.query('UPDATE catalog_structure_state SET initialized=true,revision=revision+1 WHERE slot=1');
        }).catch(error=>{this.ready=null;throw error;});
        return this.ready;
    }
    async rows(client=this.store.pool){return (await client.query('SELECT * FROM catalog_nodes ORDER BY level,number,id')).rows;}
    path(nodes,id){
        const byId=new Map(nodes.map(node=>[node.id,node])),path=[];
        for(let current=byId.get(id);current;current=byId.get(current.parent_id)) path.unshift(current);
        return path;
    }
    subtree(nodes,id){
        const result=new Set([id]);
        for(const node of nodes) if(result.has(node.parent_id))result.add(node.id);
        return nodes.filter(node=>result.has(node.id));
    }
    metadata(path){
        return {...Object.fromEntries(path.map(node=>[levels[node.level].key,node.name])),materialCode:code(path),archived:false};
    }
    async writeItem(client,id,item){
        await client.query('INSERT INTO catalog_overrides VALUES($1,$2) ON CONFLICT(file_id) DO UPDATE SET item=$2',[id,JSON.stringify(item)]);
    }
    async bump(client){return (await client.query('UPDATE catalog_structure_state SET revision=revision+1 WHERE slot=1 RETURNING revision')).rows[0].revision;}
    async insert(client,nodes,parent,level,name,materialId=null,requestKey=null){
        const number=1+Math.max(0,...nodes.filter(node=>node.parent_id===parent).map(node=>node.number));
        if(number>99)throw new CatalogError('В этом разделе закончились номера 01–99. Удалённые номера не используются повторно.');
        return (await client.query(`INSERT INTO catalog_nodes(id,parent_id,level,number,name,material_id,creation_key)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[randomUUID(),parent,level,number,name,materialId,requestKey])).rows[0];
    }
    requireNode(nodes,id){
        const node=nodes.find(node=>node.id===id && !node.archived);
        if(!node)throw new CatalogError('Раздел не найден или удалён. Обновите список.',404);
        return node;
    }
    async browse(base,id=null){
        await this.ensure(base);
        // A repeatable snapshot keeps the deletion preview and its revision consistent.
        const client=await this.store.pool.connect();
        try{
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const nodes=(await this.rows(client)).filter(node=>!node.archived);
            const parent=id===null ? null : this.requireNode(nodes,id);
            const path=id===null ? [] : this.path(nodes,id);
            const decorate=node=>{
                const descendants=this.subtree(nodes,node.id);
                return {...node,code:code(this.path(nodes,node.id)),descendantCount:descendants.length-1,variantCount:descendants.filter(n=>n.level===6).length};
            };
            const children=nodes.filter(node=>node.parent_id===id).map(decorate);
            const revision=(await client.query('SELECT revision FROM catalog_structure_state WHERE slot=1')).rows[0].revision;
            const item=parent?.level===6 ? (await this.store.catalog(base,client))[parent.material_id] : null;
            const ids=item ? [item.telegramFileId,item.taskTelegramFileId].filter(Boolean) : [];
            const files=ids.length ? (await client.query('SELECT file_id,name FROM uploaded_documents WHERE file_id=ANY($1::text[])',[ids])).rows : [];
            await client.query('COMMIT');
            return {node:parent ? decorate(parent) : null,path,children,revision,item,files};
        }catch(error){await client.query('ROLLBACK');throw error;}
        finally{client.release();}
    }
    async create(base,parentId,name,requestKey){
        await this.ensure(base);
        return this.store.editCatalog(async client=>{
            const nodes=await this.rows(client), previous=nodes.find(node=>node.creation_key===requestKey);
            if(previous){
                if(previous.archived || previous.parent_id!==parentId || previous.name!==name)throw new CatalogError('Этот запрос уже использован. Обновите список.');
                return previous;
            }
            const parent=parentId===null ? null : this.requireNode(nodes,parentId);
            const level=parent ? parent.level+1 : 0;
            if(level>6)throw new CatalogError('Внутри варианта нельзя создавать разделы.',400);
            if(nodes.some(node=>!node.archived && node.parent_id===parentId && node.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))throw new CatalogError('В этом разделе уже есть такое название. Откройте существующую запись или укажите другое название.');
            const node=await this.insert(client,nodes,parentId,level,name,level===6 ? randomUUID() : null,requestKey);
            if(level===6)await this.writeItem(client,node.material_id,{
                ...this.metadata([...this.path(nodes,parentId),node]),desc:'',type:'free',priceStars:null,priceRub:null,
                telegramFileId:null,taskTelegramFileId:null,disabled:true
            });
            await this.bump(client);return node;
        });
    }
    async rename(base,id,name,expectedVersion){
        await this.ensure(base);
        return this.store.editCatalog(async client=>{
            const nodes=await this.rows(client), node=this.requireNode(nodes,id);
            if(node.name===name)return node;
            if(node.version!==expectedVersion)throw new CatalogError('Раздел уже изменился. Обновите список и повторите.');
            if(nodes.some(other=>!other.archived && other.id!==id && other.parent_id===node.parent_id && other.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))throw new CatalogError('В этом разделе уже есть такое название.');
            node.name=name;node.version++;
            await client.query('UPDATE catalog_nodes SET name=$2,version=version+1 WHERE id=$1',[id,name]);
            const items=await this.store.catalog(base,client);
            for(const descendant of this.subtree(nodes,id).filter(n=>!n.archived && n.level===6)){
                await this.writeItem(client,descendant.material_id,{...items[descendant.material_id],...this.metadata(this.path(nodes,descendant.id))});
                if(descendant.id!==id)await client.query('UPDATE catalog_nodes SET version=version+1 WHERE id=$1',[descendant.id]);
            }
            await this.bump(client);return node;
        });
    }
    async remove(base,id,expectedRevision){
        await this.ensure(base);
        return this.store.editCatalog(async client=>{
            const nodes=await this.rows(client),node=nodes.find(n=>n.id===id);
            if(!node)throw new CatalogError('Раздел не найден.',404);
            if(node.archived)return {removed:0,parentId:node.parent_id};
            const revision=(await client.query('SELECT revision FROM catalog_structure_state WHERE slot=1')).rows[0].revision;
            if(revision!==expectedRevision)throw new CatalogError('Каталог изменился. Обновите список и заново проверьте, что будет удалено.');
            const subtree=this.subtree(nodes,id).filter(n=>!n.archived),items=await this.store.catalog(base,client);
            await client.query('UPDATE catalog_nodes SET archived=true,version=version+1 WHERE id=ANY($1::text[])',[subtree.map(n=>n.id)]);
            for(const leaf of subtree.filter(n=>n.level===6))await this.writeItem(client,leaf.material_id,{...items[leaf.material_id],archived:true});
            await this.bump(client);return {removed:subtree.length,parentId:node.parent_id};
        });
    }
    async saveVariant(base,id,values,expectedVersion){
        await this.ensure(base);
        return this.store.editCatalog(async client=>{
            const nodes=await this.rows(client),node=this.requireNode(nodes,id);
            if(node.level!==6)throw new CatalogError('Файлы и цена настраиваются только у варианта.',400);
            if(node.version!==expectedVersion)throw new CatalogError('Вариант уже изменился. Обновите его перед сохранением.');
            const item={...values,...this.metadata(this.path(nodes,id))};
            await this.writeItem(client,node.material_id,item);
            node.version++;
            await client.query('UPDATE catalog_nodes SET version=version+1 WHERE id=$1',[id]);
            const revision=await this.bump(client);
            return {node,item,revision};
        });
    }
}
module.exports={Hierarchy,schema};
