import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Command pattern: undo/redo history, macro, composite.
export interface Command{execute():void;undo():void;describe?():string}
export class CommandHistory{
  private done:Command[]=[];private undone:Command[]=[]
  execute(cmd:Command):void{cmd.execute();this.done.push(cmd);this.undone=[]}
  undo():boolean{const c=this.done.pop();if(!c)return false;c.undo();this.undone.push(c);return true}
  redo():boolean{const c=this.undone.pop();if(!c)return false;c.execute();this.done.push(c);return true}
  canUndo():boolean{return this.done.length>0}
  canRedo():boolean{return this.undone.length>0}
  history():string[]{return this.done.map(c=>c.describe?.()??'command')}
}
export class MacroCommand implements Command{
  private cmds:Command[]
  constructor(cmds:Command[]){this.cmds=cmds}
  execute():void{this.cmds.forEach(c=>c.execute())}
  undo():void{[...this.cmds].reverse().forEach(c=>c.undo())}
  describe():string{return\`macro[\${this.cmds.map(c=>c.describe?.()??'cmd').join(',')}]\`}
}
`
registerSkill({
  id: 'command-pattern',
  summary: 'Command pattern: undo/redo history, macro command, composite.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcommand.?pattern\b/i)) sc += 0.5
    if (s.has(/\bundo\b/i) && s.has(/\bredo\b/i)) sc += 0.35
    if (s.has(/\bmacro.?command\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/command.ts', content: IMPL }]
  },
})
