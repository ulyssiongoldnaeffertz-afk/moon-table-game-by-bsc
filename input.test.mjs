import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompositionGuard} from './composition.mjs';
import {patchChildren} from './dom.mjs';
import {readFileSync} from 'node:fs';

class DomNode {
  constructor(tag,text=''){this.nodeType=tag==='#text'?3:1;this.tagName=tag.toUpperCase();this.nodeValue=this.nodeType===3?text:null;this.childNodes=[];this.parentNode=null;this.attrs=new Map();this._value='';this._default='';this.assignments=0;this.selectionStart=0;this.selectionEnd=0;this.dirty=false;}
  get attributes(){return [...this.attrs].map(([name,value])=>({name,value}));}
  getAttribute(k){return this.attrs.get(k)??null;} hasAttribute(k){return this.attrs.has(k);} removeAttribute(k){this.attrs.delete(k);}
  setAttribute(k,v){this.attrs.set(k,String(v));if(k==='value'&&!this.dirty)this._value=String(v);}
  get id(){return this.getAttribute('id')??'';} get type(){return this.getAttribute('type')??'text';}
  get value(){return this._value;}set value(v){this._value=v;this.assignments++;this.dirty=true;this.selectionStart=this.selectionEnd=v.length;}
  get defaultValue(){return this._default;}set defaultValue(v){this._default=v;if(!this.dirty)this._value=v;this.textContent=v;}
  get firstChild(){return this.childNodes[0]??null;}get nextSibling(){if(!this.parentNode)return null;return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this)+1]??null;}
  get textContent(){return this.nodeType===3?this.nodeValue:this.childNodes.map(n=>n.textContent).join('');}set textContent(v){this.childNodes=[];if(v)this.append(new DomNode('#text',v));}
  append(n){this.insertBefore(n,null);return n;}
  insertBefore(n,before){if(n.parentNode)n.parentNode.removeChild(n);const i=before?this.childNodes.indexOf(before):this.childNodes.length;assert.ok(i>=0);this.childNodes.splice(i,0,n);n.parentNode=this;return n;}
  removeChild(n){this.childNodes.splice(this.childNodes.indexOf(n),1);n.parentNode=null;}
  cloneNode(deep){const n=new DomNode(this.nodeType===3?'#text':this.tagName,this.nodeValue);for(const[k,v]of this.attrs)n.setAttribute(k,v);n._value=this._value;n._default=this._default;if(deep)for(const child of this.childNodes)n.append(child.cloneNode(true));return n;}
}
const el=(tag,key,text='')=>{const n=new DomNode(tag);if(key)n.setAttribute('data-key',key);if(text)n.textContent=text;return n;};
function tree(text='你好',message='等待朋友',extra=false){const root=el('main','');const panel=root.append(el('section','pane'));if(extra)panel.append(el('p','new','另一位玩家已准备'));panel.append(el('p','message',message));const form=panel.append(el('form','chat'));const field=form.append(el('input','chat-input'));field.setAttribute('value',text);return {root,panel,form,field};}

test('拼音组合态与尾随input期间合并重绘，最终汉字完整保留、只刷新一次',()=>{
  const scheduled=[],field={value:'ni',dataset:{focus:'wolf-chat'}};const guard=createCompositionGuard(fn=>scheduled.push(fn));let renders=0,draft='';
  guard.start(field,'game:night1');assert.equal(guard.blocked(),true);
  for(let i=0;i<8;i++)assert.equal(guard.defer(),true);
  guard.end(field,'game:night1',node=>draft=node.value,()=>renders++);
  assert.equal(guard.blocked(),true);assert.equal(guard.defer(),true);field.value='你们先锁票';scheduled.shift()();
  assert.equal(draft,'你们先锁票');assert.equal(renders,1);assert.equal(guard.blocked(),false);
});

test('下一夜到来不把上一夜的候选词写回；导航取消后延迟回调不复活旧草稿',()=>{
  let committed=false,rendered=false;const tasks=[];const guard=createCompositionGuard(fn=>tasks.push(fn));const input={value:'旧草稿'};
  guard.start(input,'night1');guard.defer();guard.end(input,'night2',()=>committed=true,()=>rendered=true);tasks.shift()();assert.equal(committed,false);assert.equal(rendered,true);
  guard.start(input,'night2');guard.defer();guard.end(input,'night2',()=>committed=true,()=>rendered=true);guard.cancel();tasks.shift()();assert.equal(committed,false);
});

test('Android仅input.isComposing也能启动保护；新组合开始不会被旧回调结束',()=>{
  const tasks=[],field={};const guard=createCompositionGuard(fn=>tasks.push(fn));guard.input({target:field,isComposing:true},'n');guard.defer();assert.equal(guard.blocked(),true);guard.end(field,'n',()=>assert.fail('stale'),()=>{});guard.start(field,'n');tasks.shift()();assert.equal(guard.blocked(),true);
});

test('远端准备与消息插入时，输入节点、焦点所在祖先、光标和输入值均不被替换',()=>{
  const old=tree('你好');old.field.value='正在输入的中文';old.field.selectionStart=3;old.field.selectionEnd=5;const assignments=old.field.assignments;
  const updated=tree('正在输入的中文','玩家2已锁票',true);patchChildren(old.root,updated.root,old.field);
  assert.equal(old.root.firstChild,old.panel);assert.equal(old.panel.childNodes.find(n=>n.getAttribute('data-key')==='chat'),old.form);assert.equal(old.form.firstChild,old.field);
  assert.equal(old.field.value,'正在输入的中文');assert.equal(old.field.selectionStart,3);assert.equal(old.field.selectionEnd,5);assert.equal(old.field.assignments,assignments);
  assert.equal(old.panel.childNodes.find(n=>n.getAttribute('data-key')==='message').textContent,'玩家2已锁票');
});

test('成功发送后可显式清空同一输入节点；textarea也保留节点与已输入内容',()=>{
  const old=tree('旧消息');old.field.value='旧消息';const fresh=tree('');patchChildren(old.root,fresh.root,old.field);assert.equal(old.form.firstChild,old.field);assert.equal(old.field.value,'');
  const parent=el('div',''),text=parent.append(el('textarea','memo','初始'));text.value='保留这段中文';text.selectionStart=2;text.selectionEnd=2;
  const next=el('div','');next.append(el('textarea','memo','保留这段中文'));patchChildren(parent,next,text);assert.equal(parent.firstChild,text);assert.equal(text.value,'保留这段中文');assert.equal(text.selectionStart,2);
});

test('现场root不再使用innerHTML，全量模板解析仅发生在离线template',()=>{
  const source=readFileSync(new URL('./app.mjs',import.meta.url),'utf8');assert.ok(!/root\.innerHTML\s*=/.test(source));assert.ok(source.includes('ime.defer()'));assert.ok(source.includes('if(ime.blocked() || event.isComposing)return;'));
});

test('缺少compositionend时，尾随isComposing=false输入也能解除保护',()=>{
  const tasks=[],field={value:'zhong'},guard=createCompositionGuard(fn=>tasks.push(fn));let draft='';
  guard.input({target:field,isComposing:true},'night');guard.defer();field.value='中文';guard.input({target:field,isComposing:false},'night',node=>draft=node.value,()=>{});tasks.shift()();assert.equal(guard.blocked(),false);assert.equal(draft,'中文');
});
