// Rendering is delayed until the final non-composing input event has been received.
export function createCompositionGuard(schedule=fn=>setTimeout(fn,0)) {
  let target=null,context=null,settling=false,pending=false,sequence=0,fallback=false;
  return {
    start(node,scope) {sequence++;target=node;context=scope;settling=false;fallback=false;},
    input(event,scope,commit=()=>{},render=()=>{}) {
      if(event.isComposing && !target){sequence++;target=event.target;context=scope;fallback=true;}
      else if(!event.isComposing && fallback && target===event.target)this.end(event.target,scope,commit,render);
    },
    blocked() {return Boolean(target || settling);},
    defer() {if(target || settling){pending=true;return true;}return false;},
    end(node,currentScope,commit,render) {
      if(target && node!==target)return;
      const valid=context===currentScope;
      const ticket=sequence;
      target=null;settling=true;fallback=false;
      schedule(()=>{if(target || ticket!==sequence)return;settling=false;if(valid)commit(node);if(pending){pending=false;render();}});
    },
    cancel(){sequence++;target=null;settling=false;context=null;pending=false;fallback=false;}
  };
}
