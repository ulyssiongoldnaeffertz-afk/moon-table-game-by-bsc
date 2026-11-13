// Tiny keyed reconciler: live input/textarea nodes survive server snapshots.
// innerHTML is used only on a detached <template>, never on the live root.
function key(node) {
  if(node.nodeType!==1)return null;
  return node.getAttribute('data-key') || node.id || (node.getAttribute('data-focus')?'focus:'+node.getAttribute('data-focus'):null)
    || (node.getAttribute('data-form')?'form:'+node.getAttribute('data-form'):null);
}
const compatible=(a,b)=>a.nodeType===b.nodeType && (a.nodeType!==1 || a.tagName===b.tagName);
function patchNode(oldNode,newNode,active) {
  if(oldNode.nodeType===3 || oldNode.nodeType===8){if(oldNode.nodeValue!==newNode.nodeValue)oldNode.nodeValue=newNode.nodeValue;return;}
  if(oldNode.nodeType!==1)return;
  const tag=oldNode.tagName;
  const control=tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT';
  const declared=tag==='TEXTAREA'?oldNode.textContent:oldNode.getAttribute('value')??'';
  const desired=tag==='TEXTAREA'?newNode.textContent:newNode.getAttribute('value')??'';
  for(const attr of [...oldNode.attributes])if(!newNode.hasAttribute(attr.name))oldNode.removeAttribute(attr.name);
  for(const attr of [...newNode.attributes])if(oldNode.getAttribute(attr.name)!==attr.value)oldNode.setAttribute(attr.name,attr.value);
  if(tag==='TEXTAREA') {
    if(oldNode!==active || declared!==desired){if(oldNode.value!==desired)oldNode.value=desired;}
    // Keep text nodes stable too; defaultValue does not change a dirty textarea's selection.
    if(oldNode.defaultValue!==desired)oldNode.defaultValue=desired;
    return;
  }
  if(tag==='INPUT') {
    if(oldNode.type==='checkbox'||oldNode.type==='radio')oldNode.checked=newNode.hasAttribute('checked');
    else if((oldNode!==active || declared!==desired) && oldNode.value!==desired)oldNode.value=desired;
    return;
  }
  patchChildren(oldNode,newNode,active);
  if(control && tag==='SELECT' && oldNode!==active)oldNode.value=newNode.value;
}
export function patchChildren(parent,source,active=null) {
  const original=[...parent.childNodes];const used=new Set();
  const keyed=new Map(original.map(node=>[key(node),node]).filter(([id])=>id));
  let cursor=parent.firstChild;
  for(const next of [...source.childNodes]) {
    const id=key(next);
    let node=id?keyed.get(id):null;
    if(node && (!compatible(node,next)||used.has(node)))node=null;
    if(!node && !id)node=original.find(old=>!used.has(old)&&!key(old)&&compatible(old,next));
    if(!node)node=next.cloneNode(true);
    else patchNode(node,next,active);
    used.add(node);
    if(node!==cursor)parent.insertBefore(node,cursor);
    cursor=node.nextSibling;
  }
  for(const node of original)if(!used.has(node)&&node.parentNode===parent)parent.removeChild(node);
}
export function patchHTML(root,html,active=root.ownerDocument.activeElement) {
  const template=root.ownerDocument.createElement('template');template.innerHTML=html;
  patchChildren(root,template.content,active);
}
